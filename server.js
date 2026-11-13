'use strict';

/**
 * Cosmic Arena — authoritative multiplayer server.
 * All game logic (physics, collisions, bot AI, waves, scoring) lives here.
 * Clients only send input and render interpolated state.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ *
 *  Configuration
 * ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;
const MAP_W = 3200;
const MAP_H = 2400;

const TICK_HZ = 60;
const NET_HZ = 30;
const DT = 1 / TICK_HZ;
const NET_EVERY = Math.max(1, Math.round(TICK_HZ / NET_HZ));

const SHIELD_REGEN_DELAY = 4;   // s without damage before shield regen starts
const SHIELD_REGEN_RATE = 26;   // shield points / s
const RESPAWN_TIME = 3;         // s
const DASH_COOLDOWN = 3;        // s
const DASH_TIME = 0.35;         // s of invulnerability + boost
const DASH_SPEED = 950;         // px / s boost
const INTERMISSION_TIME = 5;    // s between waves
const POWERUP_INTERVAL = 8;     // s between power-up spawns
const MAX_POWERUPS = 6;
const MULTIKILL_WINDOW = 3;     // s

// Путь к статистике можно переопределить (полезно на хостинге: STATS_FILE=/data/stats.json).
const STATS_FILE = process.env.STATS_FILE
  ? path.resolve(process.env.STATS_FILE)
  : path.join(__dirname, 'stats.json');

/* ------------------------------------------------------------------ *
 *  Ships / bots / power-ups definition (also shipped to the client)
 * ------------------------------------------------------------------ */

const SHIPS = {
  interceptor: { label: 'Interceptor', maxHp: 80, maxShield: 60, speed: 300, accel: 1000, turn: 10, fireRate: 0.13, damage: 9, bulletSpeed: 950, radius: 15 },
  vanguard:    { label: 'Vanguard',    maxHp: 110, maxShield: 85, speed: 260, accel: 860, turn: 8,  fireRate: 0.16, damage: 12, bulletSpeed: 860, radius: 18 },
  spectre:     { label: 'Spectre',     maxHp: 155, maxShield: 110, speed: 218, accel: 720, turn: 6.2, fireRate: 0.2, damage: 16, bulletSpeed: 790, radius: 21 },
};

const BOT_TYPES = {
  scout:    { label: 'Разведчик',  hp: 40,  speed: 200, accel: 700, radius: 14, damage: 6, fireRate: 0.85, bulletSpeed: 620, keepRange: 340, color: '#ff4d6d', score: 1 },
  cruiser:  { label: 'Крейсер',    hp: 170, speed: 95,  accel: 320, radius: 27, damage: 9, fireRate: 1.7,  bulletSpeed: 560, keepRange: 460, spread: 3, color: '#ffa53b', score: 3 },
  kamikaze: { label: 'Камикадзе',  hp: 55,  speed: 245, accel: 900, radius: 16, damage: 46, fireRate: 0,   bulletSpeed: 0,   keepRange: 0,   color: '#b06bff', score: 2 },
};

const POWERUPS = {
  repair: { label: 'Ремкомплект', color: '#3dffa0', duration: 0, amount: 45 },
  triple: { label: 'Тройной выстрел', color: '#ffd166', duration: 10 },
  rapid:  { label: 'Ускорение перезарядки', color: '#4cc9ff', duration: 10 },
};

const MODES = ['ffa', 'survival'];

/* ------------------------------------------------------------------ *
 *  Persistent statistics (stats.json)
 * ------------------------------------------------------------------ */

let stats = {};
let statsDirty = false;

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) || {};
    }
  } catch (err) {
    console.error('[stats] не удалось прочитать stats.json:', err.message);
    stats = {};
  }
}

function saveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  try {
    // На хостинге папка тома может отсутствовать (например /data) — создаём на лету.
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('[stats] не удалось записать stats.json:', err.message);
  }
}

function statFor(name) {
  if (!stats[name]) {
    stats[name] = { kills: 0, botKills: 0, deaths: 0, bestWave: 0, damage: 0, shots: 0, hits: 0, bestStreak: 0, updated: 0 };
  }
  return stats[name];
}

/* ------------------------------------------------------------------ *
 *  World state
 * ------------------------------------------------------------------ */

const ships = SHIPS;
const world = {
  mode: 'ffa',
  players: new Map(),   // socketId -> player
  bots: [],
  bullets: [],
  powerups: [],
  spawnQueue: [],
  fx: [],               // drained every broadcast
  events: [],           // kill feed / announcements, drained every broadcast
  wave: 0,
  waveState: 'idle',    // idle | intermission | active
  waveTimer: 0,
  spawnTimer: POWERUP_INTERVAL,
  hostId: null,
  votes: new Map(),
  time: 0,
};

let nextId = 1;
const uid = () => nextId++;

function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function normAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

/* ------------------------------------------------------------------ *
 *  Player helpers
 * ------------------------------------------------------------------ */

function makePlayer(socket, { name, color, ship }) {
  const model = SHIPS[ship] ? ship : 'vanguard';
  const s = SHIPS[model];
  const spawn = safeSpawnPoint();
  return {
    kind: 'player',
    id: socket.id,
    name: (name || 'Pilot').toString().slice(0, 16) || 'Pilot',
    color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#4cc9ff',
    ship: model,
    x: spawn.x, y: spawn.y, vx: 0, vy: 0, a: rand(-Math.PI, Math.PI),
    hp: s.maxHp, maxHp: s.maxHp,
    shield: s.maxShield, maxShield: s.maxShield,
    alive: true,
    respawn: 0,
    invuln: 1.5,
    dashCd: 0,
    dashTime: 0,
    fireCd: 0,
    lastDamage: -99,
    triple: 0,
    rapid: 0,
    // session stats
    kills: 0, botKills: 0, deaths: 0,
    damage: 0, shots: 0, hits: 0,
    streak: 0, bestStreak: 0, multi: 0, lastKillAt: -99,
    input: { up: false, down: false, left: false, right: false, aim: 0, fire: false, dash: false },
  };
}

function safeSpawnPoint() {
  const margin = 180;
  let best = null, bestScore = -1;
  const threats = [];
  for (const p of world.players.values()) if (p.alive) threats.push(p);
  for (const b of world.bots) threats.push(b);
  for (let i = 0; i < 12; i++) {
    const x = rand(margin, MAP_W - margin);
    const y = rand(margin, MAP_H - margin);
    let min = Infinity;
    for (const t of threats) {
      const d = dist2(x, y, t.x, t.y);
      if (d < min) min = d;
    }
    if (min === Infinity) min = 1e9;
    if (min > bestScore) { bestScore = min; best = { x, y }; }
  }
  return best || { x: MAP_W / 2, y: MAP_H / 2 };
}

function respawnPlayer(p) {
  const s = SHIPS[p.ship];
  const spawn = safeSpawnPoint();
  p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0;
  p.hp = s.maxHp; p.shield = s.maxShield;
  p.alive = true; p.respawn = 0; p.invuln = 2;
  p.dashTime = 0; p.dashCd = 0; p.fireCd = 0;
  p.triple = 0; p.rapid = 0; p.lastDamage = world.time - 99;
}

/* ------------------------------------------------------------------ *
 *  Damage / death / scoring
 * ------------------------------------------------------------------ */

function applyDamage(target, amount, attacker, sourceIsBot) {
  if (!target || !target.alive) return;

  if (target.invuln > 0 || target.dashTime > 0) return;

  const absorbed = Math.min(target.shield, amount);
  target.shield -= absorbed;
  const rest = amount - absorbed;
  if (rest > 0) target.hp -= rest;

  target.lastDamage = world.time;

  let shielded = absorbed > 0 && rest <= 0;
  world.fx.push({ k: 'hit', x: target.x, y: target.y, shield: shielded, big: rest > 0 ? 1 : 0 });

  if (attacker && attacker.kind === 'player') {
    const dealt = Math.min(amount, absorbed + rest);
    attacker.damage += dealt;
    const ps = statFor(attacker.name);
    ps.damage += dealt;
    if (!sourceIsBot) { attacker.hits += 1; ps.hits += 1; }
    statsDirty = true;
  }

  if (target.hp <= 0) killEntity(target, attacker);
}

function killEntity(target, attacker) {
  if (target.kind === 'player') {
    target.alive = false;
    target.deaths += 1;
    target.respawn = RESPAWN_TIME;
    target.streak = 0;
    target.multi = 0;
    world.fx.push({ k: 'explosion', x: target.x, y: target.y, r: 44, color: target.color, player: 1 });

    const st = statFor(target.name);
    st.deaths += 1;
    statsDirty = true;

    if (attacker && attacker.kind === 'player') {
      attacker.kills += 1;
      registerKill(attacker);
      pushEvent({ t: 'kill', killer: attacker.name, killerColor: attacker.color, victim: target.name, victimColor: target.color, bot: false });
      statFor(attacker.name).kills += 1;
      statsDirty = true;
    } else if (attacker && attacker.kind === 'bot') {
      pushEvent({ t: 'kill', killer: BOT_TYPES[attacker.type].label, killerColor: attacker.color, victim: target.name, victimColor: target.color, bot: true });
    } else {
      pushEvent({ t: 'kill', killer: 'Космос', killerColor: '#7a8ba8', victim: target.name, victimColor: target.color, bot: true });
    }
    if (world.mode === 'survival') checkWaveProgress();
  } else {
    // bot
    world.fx.push({ k: 'explosion', x: target.x, y: target.y, r: target.radius * 2.2, color: target.color });
    if (attacker && attacker.kind === 'player') {
      attacker.botKills += 1;
      registerKill(attacker);
      pushEvent({ t: 'kill', killer: attacker.name, killerColor: attacker.color, victim: BOT_TYPES[target.type].label, victimColor: target.color, bot: true });
      const st = statFor(attacker.name);
      st.botKills += 1;
      st.bestWave = Math.max(st.bestWave, world.wave);
      statsDirty = true;
    }
    removeBot(target);
    if (world.mode === 'survival') checkWaveProgress();
  }
}

function registerKill(attacker) {
  const now = world.time;
  attacker.streak += 1;
  attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
  if (now - attacker.lastKillAt <= MULTIKILL_WINDOW) attacker.multi += 1;
  else attacker.multi = 1;
  attacker.lastKillAt = now;

  const st = statFor(attacker.name);
  st.bestStreak = Math.max(st.bestStreak, attacker.bestStreak);
  statsDirty = true;

  let title = null;
  switch (attacker.multi) {
    case 2: title = { text: 'Double Kill', sub: attacker.name }; break;
    case 3: title = { text: 'Triple Kill', sub: attacker.name }; break;
    case 4: title = { text: 'Quadra Kill', sub: attacker.name }; break;
    case 5: title = { text: 'Rampage', sub: attacker.name }; break;
    default: break;
  }
  if (attacker.multi >= 6) title = { text: 'Unstoppable', sub: attacker.name };
  if (!title && attacker.streak === 3) title = { text: 'Rampage', sub: attacker.name };
  if (!title && attacker.streak === 6) title = { text: 'Unstoppable', sub: attacker.name };
  if (!title && attacker.streak === 10) title = { text: 'Godlike', sub: attacker.name };
  if (title) pushEvent({ t: 'announce', text: title.text, sub: title.sub, level: 2 });
}

function pushEvent(e) { world.events.push(e); }

/* ------------------------------------------------------------------ *
 *  Bots
 * ------------------------------------------------------------------ */

function spawnBot(type, x, y) {
  const t = BOT_TYPES[type];
  const mult = 1 + (world.wave - 1) * 0.14;
  const bot = {
    kind: 'bot',
    id: uid(),
    type,
    x, y,
    vx: rand(-40, 40), vy: rand(-40, 40),
    a: Math.atan2(MAP_H / 2 - y, MAP_W / 2 - x),
    hp: Math.round(t.hp * mult),
    maxHp: Math.round(t.hp * mult),
    shield: 0, maxShield: 0,
    radius: t.radius,
    color: t.color,
    speed: t.speed * (1 + (world.wave - 1) * 0.03),
    fireCd: rand(0.4, 1.4),
    alive: true,
    invuln: 0.4,
  };
  world.bots.push(bot);
  return bot;
}

function removeBot(bot) {
  const i = world.bots.indexOf(bot);
  if (i >= 0) world.bots.splice(i, 1);
}

function nearestPlayer(x, y) {
  let best = null, bestD = Infinity;
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const d = dist2(x, y, p.x, p.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function updateBot(bot) {
  const t = BOT_TYPES[bot.type];
  const target = nearestPlayer(bot.x, bot.y);
  if (bot.invuln > 0) bot.invuln -= DT;

  if (!target) {
    bot.vx *= 0.96; bot.vy *= 0.96;
    bot.x += bot.vx * DT; bot.y += bot.vy * DT;
    clampToMap(bot);
    return;
  }

  const dx = target.x - bot.x, dy = target.y - bot.y;
  const d = Math.hypot(dx, dy) || 1;
  const desired = Math.atan2(dy, dx);
  bot.a = desired;

  const dt = t;
  let thrust = 0;

  if (bot.type === 'kamikaze') {
    thrust = 1;
    // detonate on contact
    const hitR = bot.radius + SHIPS[target.ship].radius + 6;
    if (d < hitR) {
      world.fx.push({ k: 'explosion', x: bot.x, y: bot.y, r: 60, color: bot.color });
      // splash
      for (const p of world.players.values()) {
        if (!p.alive) continue;
        if (dist2(bot.x, bot.y, p.x, p.y) < 120 * 120) applyDamage(p, dt.damage, bot, true);
      }
      removeBot(bot);
      if (world.mode === 'survival') checkWaveProgress();
      return;
    }
  } else {
    if (d > t.keepRange + 60) thrust = 1;
    else if (d < t.keepRange - 80) thrust = -0.7;
    // gentle strafe orbit
    const strafe = Math.sin(world.time * 1.3 + bot.id) * 0.6;
    const perp = desired + Math.PI / 2;
    bot.vx += Math.cos(perp) * strafe * t.accel * 0.5 * DT;
    bot.vy += Math.sin(perp) * strafe * t.accel * 0.5 * DT;
  }

  bot.vx += Math.cos(bot.a) * thrust * t.accel * DT;
  bot.vy += Math.sin(bot.a) * thrust * t.accel * DT;

  // drag + speed cap
  const drag = bot.type === 'cruiser' ? 2.2 : 3.2;
  bot.vx -= bot.vx * drag * DT;
  bot.vy -= bot.vy * drag * DT;
  const sp = Math.hypot(bot.vx, bot.vy);
  if (sp > bot.speed) { bot.vx = bot.vx / sp * bot.speed; bot.vy = bot.vy / sp * bot.speed; }

  bot.x += bot.vx * DT; bot.y += bot.vy * DT;
  clampToMap(bot);

  // shooting
  if (t.fireRate > 0) {
    bot.fireCd -= DT;
    if (bot.fireCd <= 0 && d < t.keepRange + 380 && d > 40) {
      bot.fireCd = t.fireRate * rand(0.8, 1.25);
      const baseA = Math.atan2(target.y - bot.y, target.x - bot.x);
      const shots = t.spread || 1;
      for (let i = 0; i < shots; i++) {
        const a = baseA + (i - (shots - 1) / 2) * 0.16;
        spawnBullet(bot.x + Math.cos(a) * bot.radius, bot.y + Math.sin(a) * bot.radius, a, t.bulletSpeed, t.damage, bot, bot.color, 4.5);
      }
    }
  }
}

function clampToMap(e) {
  const r = e.radius || 18;
  if (e.x < r) { e.x = r; e.vx = Math.abs(e.vx) * 0.4; }
  if (e.x > MAP_W - r) { e.x = MAP_W - r; e.vx = -Math.abs(e.vx) * 0.4; }
  if (e.y < r) { e.y = r; e.vy = Math.abs(e.vy) * 0.4; }
  if (e.y > MAP_H - r) { e.y = MAP_H - r; e.vy = -Math.abs(e.vy) * 0.4; }
}

/* ------------------------------------------------------------------ *
 *  Bullets
 * ------------------------------------------------------------------ */

function spawnBullet(x, y, a, speed, damage, owner, color, radius) {
  world.bullets.push({
    id: uid(),
    x, y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    a,
    r: radius,
    damage,
    ownerKind: owner.kind,
    ownerId: owner.id,
    ownerRef: owner,
    team: owner.kind === 'player' ? 'player' : 'bot',
    color,
    life: 2.2,
  });
}

function playerFire(p) {
  const s = SHIPS[p.ship];
  const rate = p.rapid > 0 ? s.fireRate * 0.45 : s.fireRate;
  if (p.fireCd > 0) return;
  p.fireCd = rate;

  const nose = s.radius + 8;
  const bx = p.x + Math.cos(p.a) * nose;
  const by = p.y + Math.sin(p.a) * nose;
  const pellets = p.triple > 0 ? 3 : 1;
  for (let i = 0; i < pellets; i++) {
    const a = p.a + (i - (pellets - 1) / 2) * 0.13 + rand(-0.01, 0.01);
    spawnBullet(bx, by, a, s.bulletSpeed, s.damage, p, p.color, p.triple > 0 ? 4 : 5);
  }
  p.shots += pellets;
  const st = statFor(p.name); st.shots += pellets; statsDirty = true;

  // recoil kick
  p.vx -= Math.cos(p.a) * 26;
  p.vy -= Math.sin(p.a) * 26;
  world.fx.push({ k: 'shot', x: bx, y: by, a: p.a, color: p.color, owner: p.id });
}

function updateBullets() {
  for (let i = world.bullets.length - 1; i >= 0; i--) {
    const b = world.bullets[i];
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.life -= DT;

    let dead = b.life <= 0 || b.x < -40 || b.y < -40 || b.x > MAP_W + 40 || b.y > MAP_H + 40;

    if (!dead) {
      if (b.team === 'player') {
        // vs bots
        for (const bot of world.bots) {
          if (dist2(b.x, b.y, bot.x, bot.y) < (bot.radius + b.r) * (bot.radius + b.r)) {
            applyDamage(bot, b.damage, b.ownerRef, false);
            dead = true;
            break;
          }
        }
        if (!dead && world.mode === 'ffa') {
          for (const p of world.players.values()) {
            if (!p.alive || p.id === b.ownerId) continue;
            if (dist2(b.x, b.y, p.x, p.y) < (SHIPS[p.ship].radius + b.r) * (SHIPS[p.ship].radius + b.r)) {
              applyDamage(p, b.damage, b.ownerRef, false);
              dead = true;
              break;
            }
          }
        }
      } else {
        for (const p of world.players.values()) {
          if (!p.alive) continue;
          if (dist2(b.x, b.y, p.x, p.y) < (SHIPS[p.ship].radius + b.r) * (SHIPS[p.ship].radius + b.r)) {
            applyDamage(p, b.damage, b.ownerRef, true);
            dead = true;
            break;
          }
        }
      }
    }

    if (dead) {
      world.bullets.splice(i, 1);
      world.fx.push({ k: 'spark', x: b.x, y: b.y, color: b.color });
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Power-ups
 * ------------------------------------------------------------------ */

function spawnPowerup() {
  const keys = Object.keys(POWERUPS);
  const type = keys[Math.floor(Math.random() * keys.length)];
  const margin = 220;
  world.powerups.push({
    id: uid(),
    type,
    x: rand(margin, MAP_W - margin),
    y: rand(margin, MAP_H - margin),
    born: world.time,
  });
}

function updatePowerups() {
  world.spawnTimer -= DT;
  if (world.spawnTimer <= 0 && world.powerups.length < MAX_POWERUPS) {
    world.spawnTimer = POWERUP_INTERVAL * rand(0.7, 1.3);
    spawnPowerup();
  }

  for (let i = world.powerups.length - 1; i >= 0; i--) {
    const pu = world.powerups[i];
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      const r = SHIPS[p.ship].radius + 20;
      if (dist2(pu.x, pu.y, p.x, p.y) < r * r) {
        const def = POWERUPS[pu.type];
        if (pu.type === 'repair') {
          p.hp = Math.min(p.maxHp, p.hp + def.amount);
        } else if (pu.type === 'triple') {
          p.triple = def.duration;
        } else if (pu.type === 'rapid') {
          p.rapid = def.duration;
        }
        world.powerups.splice(i, 1);
        world.fx.push({ k: 'pickup', x: pu.x, y: pu.y, color: def.color });
        pushEvent({ t: 'feed', text: `${p.name} подобрал ${def.label}`, color: def.color });
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Game modes
 * ------------------------------------------------------------------ */

function setMode(mode, byName) {
  if (!MODES.includes(mode) || mode === world.mode) return;
  world.mode = mode;
  world.bots.length = 0;
  world.bullets.length = 0;
  world.powerups.length = 0;
  world.spawnQueue.length = 0;
  world.votes.clear();

  for (const p of world.players.values()) {
    p.kills = 0; p.botKills = 0; p.deaths = 0;
    p.damage = 0; p.shots = 0; p.hits = 0;
    p.streak = 0; p.multi = 0;
    respawnPlayer(p);
  }

  if (mode === 'survival') {
    world.wave = 0;
    world.waveState = 'intermission';
    world.waveTimer = INTERMISSION_TIME;
    pushEvent({ t: 'announce', text: 'Режим: Выживание', sub: 'Волны ботов приближаются', level: 1 });
  } else {
    world.wave = 0;
    world.waveState = 'idle';
    pushEvent({ t: 'announce', text: 'Режим: Каждый сам за себя', sub: 'Свободная охота', level: 1 });
  }
  console.log(`[mode] -> ${mode}${byName ? ' (by ' + byName + ')' : ''}`);
}

function startWave(n) {
  world.wave = n;
  world.waveState = 'active';
  world.spawnQueue.length = 0;

  const count = Math.min(38, 2 + Math.floor(n * 1.45));
  for (let i = 0; i < count; i++) {
    let type = 'scout';
    const r = Math.random();
    if (n >= 2 && n < 4) type = r < 0.65 ? 'scout' : 'cruiser';
    else if (n >= 4) type = r < 0.5 ? 'scout' : r < 0.82 ? 'cruiser' : 'kamikaze';
    world.spawnQueue.push({ type, delay: i * 0.45 });
  }

  // spawn along a random edge so waves arrive from a direction
  for (const q of world.spawnQueue) {
    const edge = Math.floor(Math.random() * 4);
    const margin = 70;
    if (edge === 0) { q.x = rand(margin, MAP_W - margin); q.y = margin; }
    else if (edge === 1) { q.x = MAP_W - margin; q.y = rand(margin, MAP_H - margin); }
    else if (edge === 2) { q.x = rand(margin, MAP_W - margin); q.y = MAP_H - margin; }
    else { q.x = margin; q.y = rand(margin, MAP_H - margin); }
  }

  pushEvent({ t: 'announce', text: `Волна ${n}`, sub: `Противников: ${count}`, level: 3 });
  for (const p of world.players.values()) {
    const st = statFor(p.name);
    st.bestWave = Math.max(st.bestWave, n);
    statsDirty = true;
  }
  console.log(`[wave] start ${n} (${count} bots)`);
}

function checkWaveProgress() {
  if (world.mode !== 'survival') return;
  if (world.waveState !== 'active') return;
  if (world.bots.length === 0 && world.spawnQueue.length === 0) {
    world.waveState = 'intermission';
    world.waveTimer = INTERMISSION_TIME;
    // restore shields between waves
    for (const p of world.players.values()) {
      p.shield = p.maxShield;
      p.hp = Math.min(p.maxHp, p.hp + 20);
    }
    pushEvent({ t: 'announce', text: `Волна ${world.wave} зачищена`, sub: `Передышка ${INTERMISSION_TIME} сек. Щиты восстановлены`, level: 2 });
  }
}

function updateSpawnQueue() {
  for (let i = world.spawnQueue.length - 1; i >= 0; i--) {
    const q = world.spawnQueue[i];
    q.delay -= DT;
    if (q.delay <= 0) {
      spawnBot(q.type, q.x, q.y);
      world.spawnQueue.splice(i, 1);
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */

function updatePlayer(p) {
  const s = SHIPS[p.ship];

  if (!p.alive) {
    p.respawn -= DT;
    if (p.respawn <= 0) respawnPlayer(p);
    return;
  }

  const inp = p.input;

  // aim rotation
  const diff = normAngle(inp.aim - p.a);
  const maxTurn = s.turn * DT;
  p.a += clamp(diff, -maxTurn, maxTurn);

  // movement with space inertia
  let ax = 0, ay = 0;
  if (inp.up) ay -= 1;
  if (inp.down) ay += 1;
  if (inp.left) ax -= 1;
  if (inp.right) ax += 1;
  if (ax || ay) {
    const len = Math.hypot(ax, ay);
    ax /= len; ay /= len;
  }

  p.vx += ax * s.accel * DT;
  p.vy += ay * s.accel * DT;

  const drag = ax || ay ? 1.6 : 2.4;
  p.vx -= p.vx * drag * DT;
  p.vy -= p.vy * drag * DT;

  // dash
  if (inp.dash) {
    inp.dash = false;
    if (p.dashCd <= 0) {
      p.dashCd = DASH_COOLDOWN;
      p.dashTime = DASH_TIME;
      p.invuln = Math.max(p.invuln, DASH_TIME);
      const da = (ax || ay) ? Math.atan2(ay, ax) : p.a;
      p.vx = Math.cos(da) * DASH_SPEED;
      p.vy = Math.sin(da) * DASH_SPEED;
      world.fx.push({ k: 'dash', x: p.x, y: p.y, a: da, color: p.color });
    }
  }

  if (p.dashCd > 0) p.dashCd -= DT;
  if (p.dashTime > 0) p.dashTime -= DT;
  if (p.invuln > 0) p.invuln -= DT;
  if (p.triple > 0) p.triple -= DT;
  if (p.rapid > 0) p.rapid -= DT;

  // speed cap
  const sp = Math.hypot(p.vx, p.vy);
  const cap = p.dashTime > 0 ? DASH_SPEED : s.speed;
  if (sp > cap) { p.vx = p.vx / sp * cap; p.vy = p.vy / sp * cap; }

  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.radius = s.radius;
  clampToMap(p);

  // shield regen
  if (world.time - p.lastDamage > SHIELD_REGEN_DELAY && p.shield < s.maxShield) {
    p.shield = Math.min(s.maxShield, p.shield + SHIELD_REGEN_RATE * DT);
  }

  // firing
  if (p.fireCd > 0) p.fireCd -= DT;
  if (inp.fire) playerFire(p);
}

let tickCount = 0;

function tick() {
  world.time += DT;
  tickCount++;

  for (const p of world.players.values()) updatePlayer(p);
  for (const b of world.bots.slice()) updateBot(b);
  updateBullets();
  updatePowerups();

  if (world.mode === 'survival') {
    updateSpawnQueue();
    if (world.waveState === 'intermission') {
      world.waveTimer -= DT;
      if (world.waveTimer <= 0) startWave(world.wave + 1);
    }
  }

  if (tickCount % NET_EVERY === 0) broadcast();
}

/* ------------------------------------------------------------------ *
 *  Networking
 * ------------------------------------------------------------------ */

function titleFor(p) {
  const acc = p.shots > 12 ? p.hits / p.shots : null;
  if (p.bestStreak >= 8) return { t: 'Берсерк', c: '#ff4d6d' };
  if (acc !== null && acc >= 0.45 && p.hits >= 25) return { t: 'Снайпер', c: '#4cc9ff' };
  if (p.botKills >= 25) return { t: 'Охотник на ботов', c: '#ffa53b' };
  if (p.deaths >= 8 && p.kills + p.botKills <= p.deaths * 0.4) return { t: 'Пушечное мясо', c: '#9aa7bd' };
  if (p.kills >= 10) return { t: 'Ас', c: '#ffd166' };
  if (p.deaths === 0 && p.kills + p.botKills >= 3) return { t: 'Неуязвимый', c: '#3dffa0' };
  if (p.deaths >= 5) return { t: 'Живучий', c: '#b06bff' };
  return null;
}

function leaderboard() {
  const rows = [];
  for (const p of world.players.values()) {
    rows.push({
      id: p.id,
      name: p.name,
      color: p.color,
      kills: p.kills,
      botKills: p.botKills,
      deaths: p.deaths,
      score: p.kills * 3 + p.botKills,
      accuracy: p.shots > 0 ? Math.round((p.hits / p.shots) * 100) : 0,
      streak: p.bestStreak,
      title: titleFor(p),
    });
  }
  rows.sort((a, b) => b.score - a.score || b.kills - a.kills);
  return rows;
}

function broadcast() {
  const t = Math.round(world.time * 1000) / 1000;

  const players = [];
  for (const p of world.players.values()) {
    players.push({
      id: p.id, name: p.name, color: p.color, ship: p.ship,
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      a: Math.round(p.a * 1000) / 1000,
      hp: Math.round(p.hp), mhp: p.maxHp,
      sh: Math.round(p.shield), msh: p.maxShield,
      alive: p.alive, resp: Math.max(0, Math.round(p.respawn * 10) / 10),
      inv: p.invuln > 0 ? 1 : 0,
      dash: p.dashCd > 0 ? Math.round(p.dashCd * 10) / 10 : 0,
      tri: p.triple > 0 ? Math.round(p.triple * 10) / 10 : 0,
      rap: p.rapid > 0 ? Math.round(p.rapid * 10) / 10 : 0,
    });
  }

  const bots = world.bots.map((b) => ({
    id: b.id, type: b.type,
    x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10,
    a: Math.round(b.a * 1000) / 1000,
    hp: Math.round(b.hp), mhp: b.maxHp, r: b.radius,
  }));

  const bullets = world.bullets.map((b) => ({
    id: b.id,
    x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10,
    vx: Math.round(b.vx), vy: Math.round(b.vy),
    c: b.color, r: b.r,
  }));

  const powerups = world.powerups.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y }));

  const payload = {
    t,
    mode: world.mode,
    map: { w: MAP_W, h: MAP_H },
    hostId: world.hostId,
    wave: world.wave,
    waveState: world.waveState,
    waveTimer: Math.max(0, Math.round(world.waveTimer * 10) / 10),
    waveBots: world.bots.length + world.spawnQueue.length,
    players, bots, bullets, powerups,
    lb: leaderboard(),
    fx: world.fx,
    events: world.events,
    votes: voteSummary(),
  };

  world.fx = [];
  world.events = [];
  io.emit('state', payload);
}

function voteSummary() {
  const counts = {};
  for (const m of world.votes.values()) counts[m] = (counts[m] || 0) + 1;
  return counts;
}

/* ------------------------------------------------------------------ *
 *  HTTP + Socket.io
 * ------------------------------------------------------------------ */

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
  const list = Object.entries(stats).map(([name, s]) => ({
    name,
    ...s,
    kd: s.deaths > 0 ? Math.round((s.kills + s.botKills) / s.deaths * 100) / 100 : (s.kills + s.botKills),
    accuracy: s.shots > 0 ? Math.round((s.hits / s.shots) * 100) : 0,
  }));
  list.sort((a, b) => (b.kills + b.botKills) - (a.kills + a.botKills));
  res.json(list.slice(0, 50));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    if (world.players.has(socket.id)) return;
    const p = makePlayer(socket, data || {});
    world.players.set(socket.id, p);
    statFor(p.name); // ensure the record exists
    statsDirty = true;

    if (!world.hostId) world.hostId = socket.id;

    socket.emit('joined', {
      id: p.id,
      map: { w: MAP_W, h: MAP_H },
      ships: SHIPS,
      powerups: POWERUPS,
      botTypes: Object.fromEntries(Object.entries(BOT_TYPES).map(([k, v]) => [k, { label: v.label, color: v.color, radius: v.radius }])),
      mode: world.mode,
      hostId: world.hostId,
    });

    pushEvent({ t: 'feed', text: `${p.name} вышел на арену`, color: p.color });
    console.log(`[join] ${p.name} (${socket.id})`);
  });

  socket.on('input', (data) => {
    const p = world.players.get(socket.id);
    if (!p || !data) return;
    const i = p.input;
    i.up = !!data.up;
    i.down = !!data.down;
    i.left = !!data.left;
    i.right = !!data.right;
    i.fire = !!data.fire;
    if (typeof data.aim === 'number' && isFinite(data.aim)) i.aim = data.aim;
    if (data.dash) i.dash = true;
  });

  socket.on('dash', () => {
    const p = world.players.get(socket.id);
    if (p) p.input.dash = true;
  });

  socket.on('setMode', ({ mode } = {}) => {
    if (socket.id !== world.hostId) return;
    setMode(mode, world.players.get(socket.id)?.name);
  });

  socket.on('voteMode', ({ mode } = {}) => {
    if (!MODES.includes(mode)) return;
    const p = world.players.get(socket.id);
    if (!p) return;
    world.votes.set(socket.id, mode);
    const counts = voteSummary();
    const total = world.players.size;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > total / 2 && best[0] !== world.mode) {
      setMode(best[0], 'голосование');
    } else {
      pushEvent({ t: 'feed', text: `${p.name} голосует за «${mode === 'ffa' ? 'Каждый сам за себя' : 'Выживание'}» (${best ? best[1] : 0}/${Math.floor(total / 2) + 1})`, color: '#9aa7bd' });
    }
  });

  socket.on('disconnect', () => {
    const p = world.players.get(socket.id);
    if (!p) return;
    world.players.delete(socket.id);
    world.votes.delete(socket.id);
    if (world.hostId === socket.id) {
      world.hostId = world.players.keys().next().value || null;
      pushEvent({ t: 'feed', text: 'Хост покинул арену, назначен новый', color: '#9aa7bd' });
    }
    pushEvent({ t: 'feed', text: `${p.name} покинул арену`, color: '#9aa7bd' });
    statsDirty = true;
    saveStats();
    console.log(`[left] ${p.name}`);
  });
});

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

const IS_WINDOWS = process.platform === 'win32';

// Виртуальные адаптеры/туннели: по таким адресам друзья не подключатся.
// Имена различаются в Linux (docker0, tun0, ...) и Windows (vEthernet (WSL), VirtualBox, ...).
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|tun|tap|wg|amn|zt|utun|tailscale|vethernet|virtualbox|hyper-v|vmware|npcap|loopback|radmin|hamachi|openvpn|wireguard)/i;
// Имена «настоящих» адаптеров Windows: Ethernet / Wi-Fi / локализованные варианты.
const WINDOWS_PHYSICAL_IFACE = /(ethernet|wi-?fi|wlan|беспровод|сетевое подключение|локальная сеть)/i;

function defaultRouteIface() {
  if (IS_WINDOWS) return null; // /proc/net/route — только Linux, на Windows выберем адаптер по имени
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const f = line.split(/\s+/);
      if (f[1] === '00000000' && f[7] === '00000000') return f[0];
    }
  } catch (err) { /* не Linux или нет доступа — не критично */ }
  return null;
}

function localIPs() {
  const route = defaultRouteIface();
  const all = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      // family бывает строкой ('IPv4') или числом (4) в зависимости от версии Node.
      if ((net.family !== 'IPv4' && net.family !== 4) || net.internal) continue;
      all.push({ name, address: net.address, virtual: VIRTUAL_IFACE.test(name) });
    }
  }
  const physical = all.filter((i) => !i.virtual);
  let main = null;
  if (route) main = physical.find((i) => i.name === route) || null;        // Linux: интерфейс маршрута по умолчанию
  if (!main && IS_WINDOWS) main = physical.find((i) => WINDOWS_PHYSICAL_IFACE.test(i.name)) || null;
  if (!main) main = physical[0] || all[0] || null;
  return { main, others: main ? all.filter((i) => i !== main) : all };
}

loadStats();

setInterval(tick, 1000 / TICK_HZ);
setInterval(saveStats, 5000);

server.listen(PORT, '0.0.0.0', () => {
  const { main, others } = localIPs();
  const line = (label, url) => console.log(`  ${label.padEnd(13)} ${url}`);
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║            C O S M I C   A R E N A           ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  line('Вы:', `http://localhost:${PORT}`);
  if (main) {
    line('Для друзей:', `http://${main.address}:${PORT}   <-- скиньте эту ссылку (${main.name})`);
  } else {
    console.log('  Не удалось определить локальный IP — используйте localhost или узнайте IP вручную.');
  }
  if (others.length) {
    console.log('');
    console.log('  Прочие адреса (VPN/Docker — обычно не нужны):');
    for (const ip of others) console.log(`    ${ip.name.padEnd(12)} http://${ip.address}:${PORT}`);
  }
  console.log('');
  console.log('  Если друзья не подключаются — откройте порт в файрволе:');
  if (IS_WINDOWS) {
    console.log(`    netsh advfirewall firewall add rule name="Cosmic Arena" dir=in action=allow protocol=TCP localport=${PORT}`);
    console.log('    (выполните в PowerShell/CMD от имени администратора)');
  } else {
    console.log(`    sudo ufw allow ${PORT}/tcp        (Ubuntu/Debian)`);
    console.log(`    sudo firewall-cmd --add-port=${PORT}/tcp   (Fedora/RHEL)`);
  }
  console.log('');
  console.log('  Игра: 60 Гц симуляция / 30 Гц рассылка состояния. Остановка — Ctrl+C.');
  console.log('');
});

process.on('SIGINT', () => {
  saveStats();
  console.log('\n[exit] статистика сохранена. Пока!');
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveStats();
  process.exit(0);
});
