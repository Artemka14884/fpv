/* ============================================================
   DRONE DEFENSE
   - "human" role: pick up a rifle, shoot down incoming attack drones
     before they destroy the base structures (turret/radar/fuel tank).
   - "drone" role: fly an FPV drone with real-ish flight physics,
     drop bombs on base structures, avoid turret fire (3-5 hits = you explode).
   No human characters are ever a target — objectives are always structures/drones.
   ============================================================ */

// ---------- tiny deterministic PRNG so every client builds the same map ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- state ----------
const state = {
  nick: localStorage.getItem('dd_nick') || '',
  role: 'human',
  mapSeed: 1,
  matchLength: 10 * 60 * 1000,
  roundEndsAt: 0,
  playing: false,
  keys: {},
  mouseDown: { left: false, right: false },
  aiming: false,
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const menuEl = $('menu'), gameEl = $('game');
const nickInput = $('nickInput'), playBtn = $('playBtn'), onlineCount = $('onlineCount'), connStatus = $('connStatus');
const droneHud = $('droneHud'), humanHud = $('humanHud'), roundHud = $('roundHud'), roundEnd = $('roundEnd');
const crosshairHelp = $('crosshairHelp');

nickInput.value = state.nick;
document.querySelectorAll('.role-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.role = btn.dataset.role;
  };
});

// ---------- chat wiring ----------
function appendChat(container, from, text, system = false) {
  const div = document.createElement('div');
  if (system) { div.className = 'sys'; div.textContent = text; }
  else { div.innerHTML = `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`; }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

const lobbyMessages = $('lobbyMessages'), lobbyChatInput = $('lobbyChatInput');
$('lobbySendBtn').onclick = () => sendLobbyChat();
lobbyChatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendLobbyChat(); });
function sendLobbyChat() {
  const t = lobbyChatInput.value.trim();
  if (!t) return;
  Net.sendChat(t);
  lobbyChatInput.value = '';
}

const gameChat = $('gameChat'), gameChatMessages = $('gameChatMessages'), gameChatInput = $('gameChatInput');
let chatOpen = false;
function toggleGameChat(open) {
  chatOpen = open;
  gameChat.classList.toggle('hidden', !open);
  if (open) { document.exitPointerLock(); gameChatInput.focus(); }
  else { gameChatInput.value = ''; renderer.domElement.requestPointerLock(); }
}
gameChatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const t = gameChatInput.value.trim();
    if (t) Net.sendChat(t);
    toggleGameChat(false);
  } else if (e.key === 'Escape') toggleGameChat(false);
});

Net.on('chat', (msg) => {
  appendChat(lobbyMessages, msg.from, msg.text, msg.system);
  appendChat(gameChatMessages, msg.from, msg.text, msg.system);
});
Net.on('playerJoined', () => { onlineCount.textContent = `Онлайн: ${++onlineN}`; });
Net.on('playerLeft', () => { onlineCount.textContent = `Онлайн: ${Math.max(0, --onlineN)}`; });
Net.on('round', (msg) => { state.mapSeed = msg.mapSeed; state.roundEndsAt = Date.now() + msg.matchLength; if (state.playing) rebuildMap(); });
let onlineN = 1;

// ---------- connect on load so lobby chat works pre-game ----------
(async () => {
  const nick = state.nick || 'Pilot' + Math.floor(Math.random()*1000);
  const welcome = await Net.connect(nick, state.role);
  if (welcome) {
    connStatus.textContent = 'Подключено';
    onlineN = welcome.players.length || 1;
    onlineCount.textContent = `Онлайн: ${onlineN}`;
    state.mapSeed = welcome.mapSeed;
    state.matchLength = welcome.matchLength;
    state.roundEndsAt = Date.now() + welcome.timeLeft;
  } else {
    connStatus.textContent = 'Оффлайн-режим (сервер недоступен)';
    state.roundEndsAt = Date.now() + state.matchLength;
  }
})();

playBtn.onclick = () => {
  const nick = nickInput.value.trim() || 'Pilot';
  localStorage.setItem('dd_nick', nick);
  state.nick = nick;
  startGame();
};

$('menuExitBtn').onclick = () => { returnToMenu(); };
$('backToMenuBtn').onclick = () => { returnToMenu(); };

function returnToMenu() {
  state.playing = false;
  document.exitPointerLock();
  gameEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  roundEnd.classList.add('hidden');
}

// ================================================================
// THREE / CANNON SETUP
// ================================================================
let renderer, scene, camera, world;
let clockLast = performance.now();
const dynamicObjects = []; // { mesh, body }
const structures = [];     // base targets { mesh, body, hp, maxHp, kind }
const enemyDrones = [];    // AI or player drone { mesh, body, hp, alive, ... }
const bullets = [];
const explosions = [];
let playerDrone = null;    // when role === drone
let playerHuman = null;    // when role === human: { body, weaponHeld, ammo, mag, hp }
let turrets = [];

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fd3ef);
  scene.fog = new THREE.Fog(0x9fd3ef, 60, 420);

  camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 1000);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x445544, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.position.set(100, 150, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -150; sun.shadow.camera.right = 150;
  sun.shadow.camera.top = 150; sun.shadow.camera.bottom = -150;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function initWorld() {
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;

  const groundMat = new CANNON.Material('ground');
  const groundBody = new CANNON.Body({ mass: 0, material: groundMat, shape: new CANNON.Plane() });
  groundBody.quaternion.setFromEuler(-Math.PI/2, 0, 0);
  world.addBody(groundBody);
}

function clearMap() {
  [...dynamicObjects, ...structures, ...enemyDrones].forEach(o => {
    if (o.mesh) scene.remove(o.mesh);
    if (o.body) world.removeBody(o.body);
  });
  dynamicObjects.length = 0; structures.length = 0; enemyDrones.length = 0; turrets = [];
  bullets.forEach(b => scene.remove(b.mesh)); bullets.length = 0;
}

function addBox(pos, size, color, mass = 0) {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos); mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  const body = new CANNON.Body({ mass, shape: new CANNON.Box(new CANNON.Vec3(size.x/2, size.y/2, size.z/2)) });
  body.position.set(pos.x, pos.y, pos.z);
  world.addBody(body);
  return { mesh, body };
}

function buildMap(seed) {
  clearMap();
  const rnd = mulberry32(seed);

  // ground plane visual
  const groundGeo = new THREE.PlaneGeometry(600, 600, 40, 40);
  groundGeo.rotateX(-Math.PI/2);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 1 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  dynamicObjects.push({ mesh: groundMesh, body: null });

  // scattered terrain props (non-targets, purely visual clutter)
  for (let i = 0; i < 40; i++) {
    const x = (rnd()-0.5)*500, z = (rnd()-0.5)*500;
    if (Math.hypot(x,z) < 40) continue;
    const h = 2 + rnd()*4;
    const geo = new THREE.ConeGeometry(1.2+rnd(), h, 6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2f5030 }));
    mesh.position.set(x, h/2, z); mesh.castShadow = true;
    scene.add(mesh);
    dynamicObjects.push({ mesh, body: null });
  }

  // ---- base structures (drone objectives) ----
  const structDefs = [
    { kind: 'radar', pos: new THREE.Vector3(-20, 4, -10), size: {x:4,y:8,z:4}, color: 0x88999a, hp: 150 },
    { kind: 'fuel',  pos: new THREE.Vector3(15, 2.5, -15), size: {x:5,y:5,z:5}, color: 0xcc4433, hp: 200 },
    { kind: 'comms', pos: new THREE.Vector3(0, 6, 20), size: {x:3,y:12,z:3}, color: 0x999966, hp: 120 },
    { kind: 'depot', pos: new THREE.Vector3(-25, 3, 18), size: {x:8,y:6,z:6}, color: 0x556b2f, hp: 220 },
  ];
  structDefs.forEach(d => {
    const { mesh, body } = addBox(d.pos, d.size, d.color, 0);
    mesh.userData.kind = d.kind;
    structures.push({ mesh, body, hp: d.hp, maxHp: d.hp, kind: d.kind });
  });

  // ---- defense turrets (shoot at drones) ----
  for (let i = 0; i < 4; i++) {
    const ang = (i/4)*Math.PI*2;
    const pos = new THREE.Vector3(Math.cos(ang)*30, 1.5, Math.sin(ang)*30);
    const base = addBox(pos, {x:1.6,y:3,z:1.6}, 0x333333, 0);
    const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8,1,3), new THREE.MeshStandardMaterial({ color: 0x445544 }));
    turretMesh.position.set(pos.x, pos.y+1.8, pos.z);
    turretMesh.castShadow = true;
    scene.add(turretMesh);
    turrets.push({ mesh: turretMesh, base: base.mesh, pos: turretMesh.position.clone(), cooldown: 0, hp: 60, alive: true });
  }

  // ---- weapon pickup crate for human role ----
  const crate = addBox(new THREE.Vector3(3, 0.5, 3), {x:1,y:1,z:1}, 0x8b6b3a, 0);
  crate.mesh.userData.isWeaponCrate = true;
  dynamicObjects.push(crate);

  return { structDefs };
}

// ================================================================
// PLAYER: HUMAN
// ================================================================
function spawnHuman() {
  playerHuman = {
    pos: new THREE.Vector3(0, 1.7, 6),
    vel: new THREE.Vector3(),
    yaw: Math.PI, pitch: 0,
    weaponHeld: false, ammo: 30, mag: 90, hp: 100,
    onGround: true, jumpVel: 0,
  };
  camera.position.copy(playerHuman.pos);
  humanHud.classList.remove('hidden');
  droneHud.classList.add('hidden');
}

function updateHuman(dt) {
  const p = playerHuman;
  const speed = 6.5;
  const forward = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  const right = new THREE.Vector3(Math.sin(p.yaw+Math.PI/2), 0, Math.cos(p.yaw+Math.PI/2));
  let move = new THREE.Vector3();
  if (state.keys['KeyW']) move.add(forward);
  if (state.keys['KeyS']) move.sub(forward);
  if (state.keys['KeyD']) move.add(right);
  if (state.keys['KeyA']) move.sub(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed*dt);
  p.pos.add(move);

  // simple gravity/jump
  p.jumpVel -= 20*dt;
  p.pos.y += p.jumpVel*dt;
  if (p.pos.y <= 1.7) { p.pos.y = 1.7; p.jumpVel = 0; p.onGround = true; }
  if (state.keys['Space'] && p.onGround) { p.jumpVel = 7; p.onGround = false; }

  camera.position.copy(p.pos);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch;

  // pickup weapon
  dynamicObjects.forEach(o => {
    if (o.mesh.userData.isWeaponCrate && !p.weaponHeld) {
      if (p.pos.distanceTo(o.mesh.position) < 2.2 && state.keys['KeyE']) {
        p.weaponHeld = true;
        o.mesh.visible = false;
        $('weaponHint').textContent = 'Оружие поднято! ЛКМ — стрельба, ПКМ — прицел';
      }
    }
  });
  if (!p.weaponHeld) $('weaponHint').textContent = 'Подойдите к ящику с оружием и нажмите E';

  // shooting
  if (p.weaponHeld && state.mouseDown.left && p.ammo > 0 && !p._shotCooldown) {
    fireBullet(camera.position.clone(), forwardCameraDir(), 'human');
    p.ammo--; p._shotCooldown = true;
    setTimeout(() => p._shotCooldown = false, 110);
  }
  if (state.keys['KeyR'] && p.weaponHeld && p.mag > 0) {
    const need = 30-p.ammo; const take = Math.min(need, p.mag);
    p.ammo += take; p.mag -= take;
  }

  $('hpVal').textContent = Math.max(0, Math.round(p.hp));
  $('ammoVal').textContent = p.ammo;
  $('magVal').textContent = p.mag;

  Net.sendState(p.pos.x, p.pos.y, p.pos.z, p.yaw);
}

function forwardCameraDir() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return dir;
}

// ================================================================
// PLAYER: DRONE (real-ish flight physics via cannon-es)
// ================================================================
function spawnDrone() {
  const geo = new THREE.BoxGeometry(1, 0.25, 1);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x222222 }));
  mesh.castShadow = true;
  scene.add(mesh);

  // simple prop visuals
  for (let i=0;i<4;i++){
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,1.3,6), new THREE.MeshStandardMaterial({color:0x111111}));
    arm.rotation.z = Math.PI/2;
    arm.rotation.y = i*Math.PI/2 + Math.PI/4;
    mesh.add(arm);
  }

  const body = new CANNON.Body({
    mass: 1.2,
    shape: new CANNON.Box(new CANNON.Vec3(0.5,0.15,0.5)),
    linearDamping: 0.45,
    angularDamping: 0.7,
  });
  body.position.set(0, 25, 40);
  world.addBody(body);

  playerDrone = { mesh, body, hp: 4, bombs: 3, alive: true, thrust: 0 };
  droneHud.classList.remove('hidden');
  humanHud.classList.add('hidden');
}

function updateDrone(dt) {
  const d = playerDrone;
  if (!d.alive) return;
  const b = d.body;

  // thrust (space = up power), pitch/roll via WASD, yaw via A/D... simplified scheme:
  // W/S = pitch fwd/back, A/D = yaw, Shift/Ctrl = throttle up/down, Q/E = roll
  const throttleUp = state.keys['ShiftLeft'] || state.keys['Space'];
  const throttleDown = state.keys['ControlLeft'] || state.keys['KeyC'];
  d.thrust += ((throttleUp?1:0) - (throttleDown?1:0)) * dt * 2.2;
  d.thrust = Math.max(0, Math.min(1.6, d.thrust));

  const gravityComp = 1.2 * 9.82; // hover thrust needed to counter gravity roughly
  const up = new CANNON.Vec3(0,1,0).cross ? null : null;
  const upWorld = b.quaternion.vmult(new CANNON.Vec3(0,1,0));
  const thrustForce = gravityComp * (0.15 + d.thrust);
  b.applyForce(new CANNON.Vec3(upWorld.x*thrustForce, upWorld.y*thrustForce, upWorld.z*thrustForce), b.position);

  const pitchInput = (state.keys['KeyS']?1:0) - (state.keys['KeyW']?1:0);
  const rollInput = (state.keys['KeyD']?1:0) - (state.keys['KeyA']?1:0);
  const yawInput = (state.keys['KeyQ']?1:0) - (state.keys['KeyE']?1:0);
  const torqueStrength = 3.2;
  const localTorque = new CANNON.Vec3(pitchInput*torqueStrength, yawInput*torqueStrength, -rollInput*torqueStrength);
  const worldTorque = b.quaternion.vmult(localTorque);
  b.applyTorque(worldTorque);

  // mild self-leveling for playability
  const euler = new CANNON.Vec3();
  b.quaternion.toEuler(euler);
  b.angularVelocity.x -= euler.x * 0.6 * dt;
  b.angularVelocity.z -= euler.z * 0.6 * dt;

  // bomb drop
  if (state.keys['KeyB'] && !d._bombCooldown && d.bombs > 0) {
    dropBomb(b.position);
    d.bombs--; d._bombCooldown = true;
    setTimeout(()=>d._bombCooldown=false, 800);
  }

  d.mesh.position.copy(b.position);
  d.mesh.quaternion.copy(b.quaternion);

  // camera follows FPV (slightly above drone, looking forward)
  const camOffset = b.quaternion.vmult(new CANNON.Vec3(0, 0.3, 0));
  camera.position.set(b.position.x+camOffset.x, b.position.y+camOffset.y, b.position.z+camOffset.z);
  camera.quaternion.copy(b.quaternion);
  camera.rotateX(-0.15);

  if (b.position.y < 0.4) { crashDrone(d); }

  updateDroneHud(d);
  Net.sendState(b.position.x, b.position.y, b.position.z, 0);
}

function updateDroneHud(d) {
  const alt = Math.max(0, d.body.position.y).toFixed(0);
  $('altVal').textContent = alt;
  const speed = d.body.velocity.length()*3.6;
  $('speedVal').textContent = speed.toFixed(0);
  const euler = new CANNON.Vec3(); d.body.quaternion.toEuler(euler);
  let headingDeg = ((euler.y * 180/Math.PI) + 360) % 360;
  $('headingDeg').textContent = headingDeg.toFixed(0)+'°';
  const home = new THREE.Vector2(d.body.position.x-40, d.body.position.z-0);
  $('homeDist').textContent = Math.round(home.length())+'m';
  const now = new Date();
  $('clock1').textContent = now.toTimeString().slice(0,8);
}

function crashDrone(d) {
  if (!d.alive) return;
  d.alive = false;
  explode(d.body.position, d.mesh);
  setTimeout(() => {
    // respawn after crash
    d.body.position.set(0, 25, 40);
    d.body.velocity.set(0,0,0); d.body.angularVelocity.set(0,0,0);
    d.body.quaternion.set(0,0,0,1);
    d.hp = 4; d.thrust = 0; d.alive = true;
    d.mesh.visible = true;
  }, 2200);
}

function dropBomb(fromPos) {
  const geo = new THREE.SphereGeometry(0.25, 8, 8);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x222222 }));
  mesh.position.set(fromPos.x, fromPos.y, fromPos.z);
  scene.add(mesh);
  const body = new CANNON.Body({ mass: 3, shape: new CANNON.Sphere(0.25) });
  body.position.copy(fromPos);
  body.velocity.set(0,-2,0);
  world.addBody(body);
  const bomb = { mesh, body, isBomb: true, armed: true };
  bullets.push(bomb);
}

// ================================================================
// SHOOTING / BULLETS / DAMAGE
// ================================================================
function fireBullet(fromPos, dir, owner) {
  const geo = new THREE.SphereGeometry(0.05, 6, 6);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffe27a }));
  mesh.position.copy(fromPos);
  scene.add(mesh);
  const body = new CANNON.Body({ mass: 0.02, shape: new CANNON.Sphere(0.05), linearDamping: 0 });
  body.position.copy(fromPos);
  const speed = 140;
  body.velocity.set(dir.x*speed, dir.y*speed, dir.z*speed);
  world.addBody(body);
  bullets.push({ mesh, body, owner, born: performance.now() });
}

function explode(pos, hideMesh) {
  if (hideMesh) hideMesh.visible = false;
  const light = new THREE.PointLight(0xffaa33, 6, 20);
  light.position.copy(pos);
  scene.add(light);
  const particles = [];
  for (let i=0;i<18;i++) {
    const geo = new THREE.SphereGeometry(0.12+Math.random()*0.15, 5, 5);
    const mat = new THREE.MeshBasicMaterial({ color: i%2?0xff5522:0xffaa33 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    const vel = new THREE.Vector3((Math.random()-0.5)*8, Math.random()*8, (Math.random()-0.5)*8);
    scene.add(m);
    particles.push({ mesh: m, vel, life: 1.0 });
  }
  explosions.push({ light, particles, age: 0 });
  Net.sendExplode(pos.x, pos.y, pos.z, Math.random());
}

function updateExplosions(dt) {
  for (let i = explosions.length-1; i>=0; i--) {
    const ex = explosions[i];
    ex.age += dt;
    ex.light.intensity = Math.max(0, 6 - ex.age*8);
    ex.particles.forEach(p => {
      p.vel.y -= 9.8*dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.life -= dt*1.2;
      p.mesh.scale.setScalar(Math.max(0.01,p.life));
    });
    if (ex.age > 1.3) {
      scene.remove(ex.light);
      ex.particles.forEach(p=>scene.remove(p.mesh));
      explosions.splice(i,1);
    }
  }
}

function updateBullets(dt) {
  for (let i = bullets.length-1; i>=0; i--) {
    const b = bullets[i];
    b.mesh.position.copy(b.body.position);
    b.mesh.quaternion.copy(b.body.quaternion);

    if (b.isBomb) {
      // check ground/structure collision for bombs
      if (b.body.position.y <= 0.3) {
        detonateBomb(b);
        removeBullet(i);
        continue;
      }
      structures.forEach(s => {
        if (s.hp > 0 && b.body.position.distanceTo(s.body.position) < 3.5) {
          detonateBomb(b);
          removeBullet(i);
        }
      });
      continue;
    }

    // hitscan-ish bullet lifetime cleanup
    if (performance.now() - b.born > 3000) { removeBullet(i); continue; }

    // bullet vs enemy drones (AI) and vs player drone if human shooting
    let hit = false;
    if (b.owner === 'human') {
      const targets = playerDrone && playerDrone.alive ? [playerDrone, ...enemyDrones] : enemyDrones;
      targets.forEach(d => {
        if (!hit && d.alive && b.body.position.distanceTo(d.body.position) < 1.1) {
          hit = true;
          damageDrone(d, 1);
        }
      });
    } else if (b.owner === 'turret') {
      if (playerDrone && playerDrone.alive && b.body.position.distanceTo(playerDrone.body.position) < 1.2) {
        hit = true;
        damageDrone(playerDrone, 1);
      }
    }
    if (hit) removeBullet(i);
  }
}
function removeBullet(i) {
  const b = bullets[i];
  scene.remove(b.mesh);
  world.removeBody(b.body);
  bullets.splice(i,1);
}

function detonateBomb(b) {
  explode(b.body.position, null);
  structures.forEach(s => {
    if (s.hp > 0 && b.body.position.distanceTo(s.body.position) < 6) {
      s.hp -= 90;
      const t = Math.max(0, s.hp/s.maxHp);
      s.mesh.scale.setScalar(0.4 + 0.6*t);
      if (s.hp <= 0) { s.mesh.visible = false; }
    }
  });
}

function damageDrone(d, dmg) {
  if (!d.alive) return;
  d.hp -= dmg;
  if (d.hp <= 0) {
    if (d === playerDrone) crashDrone(d);
    else killEnemyDrone(d);
  }
}
function killEnemyDrone(d) {
  d.alive = false;
  explode(d.body.position, d.mesh);
  const idx = enemyDrones.indexOf(d);
  if (idx>=0) enemyDrones.splice(idx,1);
  world.removeBody(d.body);
}

// ================================================================
// AI ENEMY DRONES (attack the base structures; player-as-human defends)
// ================================================================
function spawnEnemyWave(rnd) {
  for (let i=0;i<5;i++) {
    const geo = new THREE.BoxGeometry(1,0.25,1);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x330000 }));
    mesh.castShadow = true;
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(0.5,0.15,0.5)), linearDamping: 0.6 });
    const ang = rnd()*Math.PI*2;
    body.position.set(Math.cos(ang)*120, 20+rnd()*10, Math.sin(ang)*120);
    world.addBody(body);
    const target = structures[Math.floor(rnd()*structures.length)];
    enemyDrones.push({ mesh, body, hp: 4, alive: true, target, state: 'approach', cooldown: rnd()*2 });
  }
}

function updateEnemyDrones(dt) {
  enemyDrones.forEach(d => {
    if (!d.alive) return;
    const tgt = (d.target && d.target.hp > 0) ? d.target.body.position : new CANNON.Vec3(0,10,0);
    const dir = new CANNON.Vec3(tgt.x - d.body.position.x, tgt.y+8 - d.body.position.y, tgt.z - d.body.position.z);
    const dist = dir.length();
    if (dist > 0.1) { dir.scale(1/dist, dir); }
    d.body.velocity.x += dir.x*dt*8;
    d.body.velocity.y += dir.y*dt*8;
    d.body.velocity.z += dir.z*dt*8;
    d.body.velocity.scale(0.985, d.body.velocity);
    d.mesh.position.copy(d.body.position);
    d.mesh.lookAt(tgt.x, d.body.position.y, tgt.z);

    d.cooldown -= dt;
    if (dist < 8 && d.cooldown <= 0 && d.target && d.target.hp > 0) {
      dropBombFromEnemy(d.body.position, d.target);
      d.cooldown = 3 + Math.random()*2;
    }
  });
}
function dropBombFromEnemy(pos, target) {
  const geo = new THREE.SphereGeometry(0.2,6,6);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({color:0x111111}));
  mesh.position.copy(pos);
  scene.add(mesh);
  const body = new CANNON.Body({ mass: 2, shape: new CANNON.Sphere(0.2) });
  body.position.copy(pos);
  world.addBody(body);
  bullets.push({ mesh, body, isBomb: true, armed: true });
}

// ================================================================
// DEFENSE TURRETS (AI, shoot the player's drone)
// ================================================================
function updateTurrets(dt) {
  if (!playerDrone || !playerDrone.alive) return;
  turrets.forEach(t => {
    if (!t.alive) return;
    const toTarget = new THREE.Vector3().subVectors(playerDrone.mesh.position, t.pos);
    const dist = toTarget.length();
    t.mesh.lookAt(playerDrone.mesh.position);
    t.cooldown -= dt;
    if (dist < 55 && t.cooldown <= 0) {
      t.cooldown = 1.1;
      const dir = toTarget.normalize();
      fireBullet(t.pos.clone(), dir, 'turret');
    }
  });
}

// ================================================================
// MAIN LOOP
// ================================================================
function rebuildMap() {
  buildMap(state.mapSeed);
  const rnd = mulberry32(state.mapSeed+999);
  spawnEnemyWave(rnd);
  if (state.role === 'human') spawnHuman();
  else spawnDrone();
}

function startGame() {
  menuEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
  state.playing = true;

  if (!renderer) { initThree(); initWorld(); }
  rebuildMap();

  renderer.domElement.onclick = () => { if (!chatOpen) renderer.domElement.requestPointerLock(); };
  crosshairHelp.classList.remove('hidden');
  document.addEventListener('pointerlockchange', () => {
    crosshairHelp.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
  });

  clockLast = performance.now();
  requestAnimationFrame(loop);
}

document.addEventListener('keydown', e => {
  if (chatOpen) return;
  state.keys[e.code] = true;
  if (e.code === 'Enter' && state.playing) toggleGameChat(true);
});
document.addEventListener('keyup', e => { state.keys[e.code] = false; });
document.addEventListener('mousedown', e => { if (e.button===0) state.mouseDown.left = true; if (e.button===2) state.mouseDown.right = true; });
document.addEventListener('mouseup', e => { if (e.button===0) state.mouseDown.left = false; if (e.button===2) state.mouseDown.right = false; });
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer?.domElement) return;
  const sens = 0.0022;
  if (state.role === 'human' && playerHuman) {
    playerHuman.yaw -= e.movementX*sens;
    playerHuman.pitch -= e.movementY*sens;
    playerHuman.pitch = Math.max(-1.4, Math.min(1.4, playerHuman.pitch));
  }
});

function updateRoundTimer() {
  const left = Math.max(0, state.roundEndsAt - Date.now());
  const m = Math.floor(left/60000), s = Math.floor((left%60000)/1000);
  $('roundTimer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  if (left <= 0 && !roundEndingHandled) {
    roundEndingHandled = true;
    showRoundEnd();
  }
}
let roundEndingHandled = false;
function showRoundEnd() {
  roundEnd.classList.remove('hidden');
  let count = 5;
  $('roundEndCountdown').textContent = count;
  const iv = setInterval(() => {
    count--;
    $('roundEndCountdown').textContent = count;
    if (count <= 0) {
      clearInterval(iv);
      roundEnd.classList.add('hidden');
      roundEndingHandled = false;
      // fall back to local regeneration if server isn't driving rounds
      state.mapSeed = Math.floor(Math.random()*1e9);
      state.roundEndsAt = Date.now() + state.matchLength;
      if (state.playing) rebuildMap();
    }
  }, 1000);
}

function loop(t) {
  if (!state.playing) return;
  const dt = Math.min(0.05, (t - clockLast)/1000);
  clockLast = t;

  world.step(1/60, dt, 3);

  if (state.role === 'human' && playerHuman) updateHuman(dt);
  if (state.role === 'drone' && playerDrone) updateDrone(dt);
  updateEnemyDrones(dt);
  updateTurrets(dt);
  updateBullets(dt);
  updateExplosions(dt);
  updateRoundTimer();

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
