// Lightweight network layer: connects to the same host's WebSocket server,
// handles chat, player presence (position/role), and the shared round clock.
const Net = (() => {
  let ws = null;
  let myId = null;
  let handlers = {};
  let online = 0;
  let connected = false;

  function on(type, fn) { handlers[type] = fn; }

  function connect(nick, role) {
    return new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}`);

      ws.onopen = () => {
        connected = true;
        ws.send(JSON.stringify({ type: 'join', nick, role }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === 'welcome') {
          myId = msg.id;
          resolve(msg);
        }
        online = Math.max(online, 1);
        if (handlers[msg.type]) handlers[msg.type](msg);
      };

      ws.onclose = () => { connected = false; if (handlers.disconnected) handlers.disconnected(); };
      ws.onerror = () => { if (!connected) resolve(null); };

      setTimeout(() => { if (!connected) resolve(null); }, 4000);
    });
  }

  function sendState(x, y, z, ry) {
    if (connected) ws.send(JSON.stringify({ type: 'state', x, y, z, ry }));
  }
  function sendChat(text) {
    if (connected) ws.send(JSON.stringify({ type: 'chat', text }));
  }
  function sendHit(targetId, dmg) {
    if (connected) ws.send(JSON.stringify({ type: 'hit', targetId, dmg }));
  }
  function sendExplode(x, y, z, id) {
    if (connected) ws.send(JSON.stringify({ type: 'explode', x, y, z, id }));
  }

  return { connect, on, sendState, sendChat, sendHit, sendExplode, get id() { return myId; }, get isConnected() { return connected; } };
})();
