// Drone Defense — online server
// Express serves the static client, WebSocket handles chat + lightweight
// presence sync (position/rotation/role/nick) + a shared 10-minute match clock.

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MATCH_LENGTH_MS = 10 * 60 * 1000; // 10 minutes

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`Drone Defense server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

// players: id -> { ws, nick, role, x,y,z, ry, hp, alive }
const players = new Map();
let nextId = 1;

// Shared match clock, all clients in the same "arena" stay in sync.
let matchStart = Date.now();
let mapSeed = Math.floor(Math.random() * 1e9);

function timeLeft() {
  const left = MATCH_LENGTH_MS - (Date.now() - matchStart);
  return Math.max(0, left);
}

function newRound() {
  matchStart = Date.now();
  mapSeed = Math.floor(Math.random() * 1e9);
  broadcast({ type: 'round', mapSeed, matchLength: MATCH_LENGTH_MS });
}

// Check every second whether the round expired -> regenerate the map.
setInterval(() => {
  if (timeLeft() <= 0) newRound();
}, 1000);

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function sanitizeNick(nick) {
  if (typeof nick !== 'string') return 'Pilot';
  const clean = nick.replace(/[^\w\- А-Яа-яЁё]/g, '').trim().slice(0, 16);
  return clean.length ? clean : 'Pilot';
}

wss.on('connection', (ws) => {
  const id = nextId++;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const nick = sanitizeNick(msg.nick);
      players.set(id, { ws, nick, role: msg.role === 'drone' ? 'drone' : 'human',
        x: 0, y: 0, z: 0, ry: 0, hp: 100, alive: true });

      ws.send(JSON.stringify({
        type: 'welcome', id, mapSeed, timeLeft: timeLeft(), matchLength: MATCH_LENGTH_MS,
        players: [...players.entries()].map(([pid, p]) => ({
          id: pid, nick: p.nick, role: p.role, x: p.x, y: p.y, z: p.z, ry: p.ry
        }))
      }));

      broadcast({ type: 'playerJoined', id, nick, role: players.get(id).role }, id);
      broadcast({ type: 'chat', from: 'Система', text: `${nick} присоединился к матчу`, system: true });
      return;
    }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === 'state') {
      p.x = msg.x; p.y = msg.y; p.z = msg.z; p.ry = msg.ry;
      broadcast({ type: 'state', id, x: p.x, y: p.y, z: p.z, ry: p.ry, role: p.role }, id);
    } else if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, 240);
      if (text.trim()) broadcast({ type: 'chat', from: p.nick, text });
    } else if (msg.type === 'hit') {
      broadcast({ type: 'hit', targetId: msg.targetId, dmg: msg.dmg, by: p.nick }, null);
    } else if (msg.type === 'explode') {
      broadcast({ type: 'explode', x: msg.x, y: msg.y, z: msg.z, id: msg.id });
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    players.delete(id);
    if (p) broadcast({ type: 'playerLeft', id, nick: p.nick });
  });
});
