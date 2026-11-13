'use strict';

/**
 * Cosmic Arena — клиент.
 * Только отправка ввода и отрисовка состояния, полученного с сервера,
 * с интерполяцией между тиками.
 */

(() => {
  /* ================= DOM ================= */
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const minimap = $('minimap');
  const mmx = minimap.getContext('2d');

  const el = {
    hud: $('hud'),
    screen: $('screen'),
    nick: $('nickInput'),
    shipGrid: $('shipGrid'),
    colorGrid: $('colorGrid'),
    play: $('playBtn'),
    modeBadge: $('modeBadge'),
    waveBadge: $('waveBadge'),
    modeSwitch: $('modeSwitch'),
    muteBtn: $('muteBtn'),
    lbBody: $('lbBody'),
    leaderboard: $('leaderboard'),
    killfeed: $('killfeed'),
    announceWrap: $('announceWrap'),
    hpFill: $('hpFill'), hpText: $('hpText'),
    shFill: $('shFill'), shText: $('shText'),
    dashCd: $('dashCd'),
    buffRow: $('buffRow'),
    waveOverlay: $('waveOverlay'),
    waveTitle: $('waveTitle'),
    waveSub: $('waveSub'),
    respawnOverlay: $('respawnOverlay'),
    rsTimer: $('rsTimer'),
    toast: $('toast'),
    statsPanel: $('statsPanel'),
    statsBtn: $('statsBtn'),
    statsClose: $('statsClose'),
    statsTableBody: $('statsTable').querySelector('tbody'),
    statsEmpty: $('statsEmpty'),
  };

  /* ================= Константы ================= */

  const COLORS = ['#4cc9ff', '#b06bff', '#3dffa0', '#ffd166', '#ff4d6d', '#ff8f3d', '#ff6bd6', '#8dff6b'];
  const INTERP_DELAY = 0.08;   // s — задержка отрисовки для плавной интерполяции
  const ZOOM = 1;

  const SHIP_SHAPES = {
    interceptor: [[23, 0], [-9, -12], [-3, 0], [-9, 12]],
    vanguard: [[21, 0], [5, -8], [-5, -9], [-14, -17], [-11, -4], [-11, 4], [-14, 17], [-5, 9], [5, 8]],
    spectre: [[24, 0], [9, -6], [1, -11], [-10, -19], [-17, -11], [-17, 11], [-10, 19], [1, 11], [9, 6]],
  };
  const BOT_SHAPES = {
    scout: [[14, 0], [-6, -8], [-2, 0], [-6, 8]],
    cruiser: [[24, 0], [10, -12], [-10, -18], [-20, -9], [-20, 9], [-10, 18], [10, 12]],
    kamikaze: [[16, 0], [0, -12], [-14, 0], [0, 12]],
  };
  const SHIP_STATS = {
    interceptor: 'Скорость ◆◆◆◆<br>Броня ◆◆',
    vanguard: 'Скорость ◆◆◆<br>Броня ◆◆◆',
    spectre: 'Скорость ◆◆<br>Броня ◆◆◆◆',
  };

  const POWERUP_ICON = { repair: '✚', triple: '⋔', rapid: '⚡' };
  const POWERUP_COLOR = { repair: '#3dffa0', triple: '#ffd166', rapid: '#4cc9ff' };

  /* ================= Состояние клиента ================= */

  const input = { up: false, down: false, left: false, right: false, fire: false, aim: 0 };
  let socket = null;
  let myId = null;
  let myInfo = null;      // {name,color,ship}
  let config = null;      // ships/botTypes/powerups/map
  let snapshots = [];     // буфер серверных состояний
  let lastState = null;   // новейшее состояние (флаги, события, HUD)
  let serverMapW = 3200, serverMapH = 2400;

  let camera = { x: 0, y: 0, shake: 0 };
  let particles = [];
  let rings = [];
  let stars = [];
  let lastOwnPos = null;
  let lastOwnSeen = 0;

  let modeVote = null;
  let respawnShown = false;
  let intermissionShown = false;
  let lastShotSound = 0;
  let lastAnnounce = null;

  /* ================= Утилиты ================= */

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function shade(hex, amt) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const r = clamp(((n >> 16) & 255) + amt, 0, 255);
    const g = clamp(((n >> 8) & 255) + amt, 0, 255);
    const b = clamp((n & 255) + amt, 0, 255);
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  /* ================= Звёздный фон ================= */

  let starTile = 2400;

  function buildStars() {
    starTile = Math.max(2000, Math.ceil(Math.max(window.innerWidth, window.innerHeight)) + 200);
    stars = [];
    const layers = [
      { n: 340, size: 0.7, speed: 0.16, alpha: 0.42 },
      { n: 200, size: 1.2, speed: 0.34, alpha: 0.68 },
      { n: 95, size: 1.9, speed: 0.58, alpha: 1 },
    ];
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        stars.push({
          x: Math.random() * starTile,
          y: Math.random() * starTile,
          z: L.speed,
          s: L.size * rand(0.7, 1.3),
          a: L.alpha * rand(0.5, 1),
          tw: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  /* ================= Эффекты ================= */

  function spawnParticles(x, y, n, color, opt = {}) {
    const spd = opt.speed || 220;
    const life = opt.life || 0.6;
    for (let i = 0; i < n; i++) {
      const a = opt.dir !== undefined ? opt.dir + rand(-0.6, 0.6) : rand(0, Math.PI * 2);
      const s = rand(spd * 0.25, spd);
      particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: life * rand(0.6, 1.2), max: life,
        size: (opt.size || 2.6) * rand(0.6, 1.5),
        color, drag: opt.drag || 2.2,
      });
    }
    if (particles.length > 1400) particles.splice(0, particles.length - 1400);
  }

  function addRing(x, y, r, color, width = 4, life = 0.45) {
    rings.push({ x, y, r: 4, maxR: r, color, width, life, max: life });
    if (rings.length > 60) rings.shift();
  }

  function engineTrail(x, y, angle, color, intensity) {
    if (Math.random() > intensity) return;
    const back = angle + Math.PI;
    particles.push({
      x: x + Math.cos(back) * 14, y: y + Math.sin(back) * 14,
      vx: Math.cos(back) * rand(60, 160) + rand(-30, 30),
      vy: Math.sin(back) * rand(60, 160) + rand(-30, 30),
      life: 0.35, max: 0.35, size: rand(1.6, 3.4),
      color: Math.random() < 0.35 ? '#ffffff' : color, drag: 3.4,
    });
  }

  /* ================= Обработка серверных событий ================= */

  function handleFx(fx, state) {
    for (const f of fx) {
      const local = isOnScreen(f.x, f.y, 220);
      if (f.k === 'explosion') {
        const col = f.color || '#ff8f3d';
        spawnParticles(f.x, f.y, f.player ? 34 : 22, col, { speed: 320, life: 0.75, size: 3.4 });
        spawnParticles(f.x, f.y, 12, '#ffffff', { speed: 420, life: 0.3, size: 2.2 });
        addRing(f.x, f.y, f.r || 40, hexToRgba(col, 0.9), 4, 0.5);
        addRing(f.x, f.y, (f.r || 40) * 1.9, hexToRgba('#ffffff', 0.35), 2, 0.35);
        camera.shake = Math.min(18, camera.shake + (f.player ? 12 : 6));
        if (local) {
          if (f.player) Sound.explosion(0.9);
          else Sound.smallExplosion(1);
        }
      } else if (f.k === 'hit') {
        spawnParticles(f.x, f.y, f.big ? 8 : 5, f.shield ? '#7fe4ff' : '#ffb36b', { speed: 180, life: 0.35, size: 2.2 });
        if (local) { if (f.shield) Sound.shieldHit(); else Sound.hullHit(); }
      } else if (f.k === 'spark') {
        spawnParticles(f.x, f.y, 3, f.color || '#fff', { speed: 90, life: 0.2, size: 1.8 });
      } else if (f.k === 'shot') {
        spawnParticles(f.x, f.y, 3, f.color, { speed: 110, dir: f.a, life: 0.16, size: 2 });
        const now = performance.now();
        if (state && f.owner === myId && now - lastShotSound > 45) {
          lastShotSound = now;
          Sound.laser(0.85);
        } else if (local && Math.random() < 0.5) {
          Sound.enemyLaser(0.5);
        }
      } else if (f.k === 'dash') {
        spawnParticles(f.x, f.y, 18, f.color, { speed: 240, dir: f.a + Math.PI, life: 0.4, size: 3 });
        addRing(f.x, f.y, 34, hexToRgba(f.color, 0.7), 3, 0.3);
        if (local) Sound.dash();
      } else if (f.k === 'pickup') {
        spawnParticles(f.x, f.y, 20, f.color, { speed: 200, life: 0.6, size: 3 });
        addRing(f.x, f.y, 42, hexToRgba(f.color, 0.85), 3, 0.5);
        if (local) Sound.pickup();
      }
    }
  }

  function isOnScreen(x, y, pad) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    return x > camera.x - w / 2 - pad && x < camera.x + w / 2 + pad &&
           y > camera.y - h / 2 - pad && y < camera.y + h / 2 + pad;
  }

  function handleEvents(events) {
    for (const e of events) {
      if (e.t === 'kill') {
        addKillFeed(`<b style="color:${e.killerColor}">${esc(e.killer)}</b> уничтожил <b style="color:${e.victimColor}">${esc(e.victim)}</b>`, e.bot);
      } else if (e.t === 'feed') {
        addKillFeed(esc(e.text), 'sys');
      } else if (e.t === 'announce') {
        announce(e.text, e.sub, e.level || 1);
      }
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function addKillFeed(html, cls) {
    const div = document.createElement('div');
    div.className = 'kf-item' + (cls === true || cls === 'bot' ? ' bot' : cls === 'sys' ? ' sys' : '');
    div.innerHTML = html;
    el.killfeed.appendChild(div);
    while (el.killfeed.children.length > 6) el.killfeed.removeChild(el.killfeed.firstChild);
    setTimeout(() => div.remove(), 6100);
  }

  function announce(text, sub, level) {
    if (lastAnnounce && lastAnnounce.text === text && performance.now() - lastAnnounce.at < 300) return;
    lastAnnounce = { text, at: performance.now() };
    const div = document.createElement('div');
    div.className = 'announce l' + level;
    div.innerHTML = `<div class="a-text">${esc(text)}</div>${sub ? `<div class="a-sub">${esc(sub)}</div>` : ''}`;
    el.announceWrap.appendChild(div);
    if (level === 3) Sound.waveStart();
    else if (level >= 2) Sound.achievement();
    setTimeout(() => div.remove(), 2900);
    while (el.announceWrap.children.length > 3) el.announceWrap.removeChild(el.announceWrap.firstChild);
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove('show'), 1800);
  }

  /* ================= Приём состояния ================= */

  function onState(s) {
    lastState = s;
    serverMapW = s.map.w;
    serverMapH = s.map.h;

    const snap = { t: s.t, players: new Map(), bots: new Map(), bullets: new Map() };
    for (const p of s.players) snap.players.set(p.id, p);
    for (const b of s.bots) snap.bots.set(b.id, b);
    for (const b of s.bullets) snap.bullets.set(b.id, b);
    snapshots.push(snap);
    if (snapshots.length > 24) snapshots.shift();

    handleFx(s.fx || [], s);
    handleEvents(s.events || []);
    updateHud(s);
  }

  /* ================= Интерполяция ================= */

  function sampleState() {
    if (snapshots.length === 0) return null;
    const newest = snapshots[snapshots.length - 1];
    if (snapshots.length === 1) return { a: newest, b: newest, f: 0 };

    // локальные часы: t - INTERP_DELAY
    let renderT = newest.t - INTERP_DELAY;
    if (renderT <= snapshots[0].t) return { a: snapshots[0], b: snapshots[0], f: 0 };

    for (let i = snapshots.length - 1; i > 0; i--) {
      if (snapshots[i - 1].t <= renderT) {
        const a = snapshots[i - 1], b = snapshots[i];
        const span = b.t - a.t || 0.001;
        return { a, b, f: clamp((renderT - a.t) / span, 0, 1) };
      }
    }
    return { a: newest, b: newest, f: 0 };
  }

  function collectEntities() {
    const s = sampleState();
    if (!s) return { players: [], bots: [], bullets: [] };

    const players = [];
    for (const [id, b] of s.b.players) {
      const a = s.a.players.get(id) || b;
      if (!b.alive && !a.alive) continue;
      players.push({
        id,
        x: lerp(a.x, b.x, s.f), y: lerp(a.y, b.y, s.f),
        a: lerpAngle(a.a, b.a, s.f),
        color: b.color, name: b.name, ship: b.ship,
        hp: b.hp, mhp: b.mhp, sh: b.sh, msh: b.msh,
        alive: b.alive, inv: b.inv, me: id === myId,
      });
    }

    const bots = [];
    for (const [id, b] of s.b.bots) {
      const a = s.a.bots.get(id) || b;
      bots.push({ id, type: b.type, x: lerp(a.x, b.x, s.f), y: lerp(a.y, b.y, s.f), a: lerpAngle(a.a, b.a, s.f), hp: b.hp, mhp: b.mhp, r: b.r });
    }

    const bullets = [];
    for (const [id, b] of s.b.bullets) {
      const a = s.a.bullets.get(id);
      const x = a ? lerp(a.x, b.x, s.f) : b.x;
      const y = a ? lerp(a.y, b.y, s.f) : b.y;
      bullets.push({ id, x, y, vx: b.vx, vy: b.vy, c: b.c, r: b.r });
    }

    return { players, bots, bullets };
  }

  /* ================= Отрисовка ================= */

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawPoly(shape, x, y, angle, scale) {
    ctx.beginPath();
    for (let i = 0; i < shape.length; i++) {
      const px = shape[i][0] * scale, py = shape[i][1] * scale;
      const rx = Math.cos(angle) * px - Math.sin(angle) * py;
      const ry = Math.sin(angle) * px + Math.cos(angle) * py;
      if (i === 0) ctx.moveTo(x + rx, y + ry);
      else ctx.lineTo(x + rx, y + ry);
    }
    ctx.closePath();
  }

  function drawShip(sp) {
    const shape = SHIP_SHAPES[sp.ship] || SHIP_SHAPES.vanguard;
    ctx.save();
    ctx.translate(sp.x, sp.y);

    if (sp.inv) {
      ctx.save();
      ctx.globalAlpha = 0.28 + Math.sin(performance.now() / 90) * 0.14;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.rotate(sp.a);
    ctx.shadowColor = sp.color;
    ctx.shadowBlur = sp.me ? 22 : 14;
    ctx.fillStyle = hexToRgba(sp.color, sp.me ? 0.34 : 0.22);
    ctx.strokeStyle = sp.me ? '#ffffff' : sp.color;
    ctx.lineWidth = sp.me ? 2.4 : 2;
    drawPoly(shape, 0, 0, 0, 1);
    ctx.fill();
    ctx.stroke();

    // кабина
    ctx.shadowBlur = 0;
    ctx.fillStyle = hexToRgba(sp.color, 0.9);
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-2, -4); ctx.lineTo(-2, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBotShape(b) {
    const color = (config && config.botTypes[b.type] && config.botTypes[b.type].color) || '#ff4d6d';
    const shape = BOT_SHAPES[b.type] || BOT_SHAPES.scout;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.a);
    const pulse = b.type === 'kamikaze' ? 0.4 + Math.sin(performance.now() / 130) * 0.3 : 0;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + pulse * 22;
    ctx.fillStyle = hexToRgba(color, 0.3 + pulse * 0.3);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    drawPoly(shape, 0, 0, 0, 1);
    ctx.fill();
    ctx.stroke();

    if (b.type === 'cruiser') {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexToRgba('#ffffff', 0.5);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHealthBar(x, y, w, pct, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y, w, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * clamp(pct, 0, 1), 4);
  }

  function render() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const now = performance.now();

    // камера
    const mine = lastState ? lastState.players.find((p) => p.id === myId) : null;
    const ents = collectEntities();
    const meEnt = ents.players.find((p) => p.me);
    const focus = meEnt || (lastOwnPos ? { x: lastOwnPos.x, y: lastOwnPos.y } : null);
    if (focus) {
      const k = meEnt ? 0.16 : 0.05;
      camera.x = lerp(camera.x, focus.x, k);
      camera.y = lerp(camera.y, focus.y, k);
      lastOwnPos = { x: focus.x, y: focus.y };
    }
    if (camera.shake > 0.1) {
      camera.x += rand(-camera.shake, camera.shake);
      camera.y += rand(-camera.shake, camera.shake);
      camera.shake *= 0.88;
    } else camera.shake = 0;

    ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
    ctx.clearRect(0, 0, w, h);

    // параллакс-звёзды (бесконечная прокрутка тайлами)
    const cx = camera.x, cy = camera.y;
    const mod = (v, m) => ((v % m) + m) % m;
    for (const st of stars) {
      const sx = mod(st.x - cx * st.z, starTile) - starTile / 2 + w / 2;
      const sy = mod(st.y - cy * st.z, starTile) - starTile / 2 + h / 2;
      if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) continue;
      const tw = 0.65 + Math.sin(now / 700 + st.tw) * 0.35;
      ctx.globalAlpha = st.a * tw;
      ctx.fillStyle = '#cfe6ff';
      ctx.fillRect(sx, sy, st.s, st.s);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(w / 2 - cx * ZOOM, h / 2 - cy * ZOOM);
    ctx.scale(ZOOM, ZOOM);

    // границы арены
    ctx.strokeStyle = 'rgba(76,201,255,0.35)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(76,201,255,0.8)';
    ctx.shadowBlur = 20;
    ctx.strokeRect(0, 0, serverMapW, serverMapH);
    ctx.shadowBlur = 0;

    // сетка
    ctx.strokeStyle = 'rgba(76,201,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= serverMapW; x += 200) { ctx.moveTo(x, 0); ctx.lineTo(x, serverMapH); }
    for (let y = 0; y <= serverMapH; y += 200) { ctx.moveTo(0, y); ctx.lineTo(serverMapW, y); }
    ctx.stroke();

    // бонусы
    if (lastState) {
      for (const pu of lastState.powerups) {
        const col = POWERUP_COLOR[pu.type] || '#fff';
        const pulse = 1 + Math.sin(now / 260 + pu.id) * 0.12;
        ctx.save();
        ctx.translate(pu.x, pu.y);
        ctx.rotate(now / 900);
        ctx.shadowColor = col;
        ctx.shadowBlur = 22;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.2;
        ctx.fillStyle = hexToRgba(col, 0.18);
        ctx.beginPath();
        const r = 15 * pulse;
        ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.rotate(-now / 900);
        ctx.shadowBlur = 0;
        ctx.fillStyle = col;
        ctx.font = 'bold 15px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(POWERUP_ICON[pu.type] || '?', 0, 1);
        ctx.restore();
      }
    }

    // шлейфы
    for (const p of ents.players) {
      if (!p.alive) continue;
      const sp = lastState && lastState.players.find((q) => q.id === p.id);
      engineTrail(p.x, p.y, p.a, p.color, p.me ? 0.95 : 0.55);
      if (sp && sp.tri > 0) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    for (const b of ents.bots) {
      engineTrail(b.x, b.y, b.a, (config && config.botTypes[b.type] && config.botTypes[b.type].color) || '#ff4d6d', 0.4);
    }

    // снаряды
    for (const bl of ents.bullets) {
      ctx.save();
      ctx.shadowColor = bl.c;
      ctx.shadowBlur = 16;
      ctx.strokeStyle = bl.c;
      ctx.lineWidth = bl.r * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bl.x - bl.vx * 0.018, bl.y - bl.vy * 0.018);
      ctx.lineTo(bl.x, bl.y);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(bl.x, bl.y, bl.r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // боты
    for (const b of ents.bots) {
      drawBotShape(b);
      if (b.hp < b.mhp) drawHealthBar(b.x, b.y - b.r - 12, b.r * 2.2, b.hp / b.mhp, '#ff6b6b');
    }

    // игроки
    for (const p of ents.players) {
      if (!p.alive) continue;
      drawShip(p);
      const bw = 34;
      if (p.hp < p.mhp || p.sh < p.msh) {
        drawHealthBar(p.x, p.y - 38, bw, p.hp / p.mhp, '#ff4d6d');
        drawHealthBar(p.x, p.y - 32, bw, p.sh / p.msh, '#4cc9ff');
      }
      // ник
      ctx.save();
      ctx.font = (p.me ? 'bold ' : '') + '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = p.me ? '#ffffff' : hexToRgba(p.color, 0.95);
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText(p.name, p.x, p.y - 44);
      ctx.restore();
    }

    // частицы
    for (const pt of particles) {
      const a = clamp(pt.life / pt.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // кольца ударных волн
    for (const r of rings) {
      const a = clamp(r.life / r.max, 0, 1);
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * a;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.restore();

    // прицел
    drawCrosshair(w, h);
    drawMinimap(ents);
  }

  function drawCrosshair(w, h) {
    const mx = input.mouseX || w / 2;
    const my = input.mouseY || h / 2;
    const t = performance.now() / 1000;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(t * 0.8);
    ctx.strokeStyle = 'rgba(140,230,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = '#4cc9ff';
    ctx.shadowBlur = 10;
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(10, 0); ctx.lineTo(18, 0);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const MM_W = 200, MM_H = 150;

  function drawMinimap(ents) {
    const W = MM_W, H = MM_H;
    mmx.clearRect(0, 0, W, H);
    const sx = W / serverMapW, sy = H / serverMapH;

    mmx.strokeStyle = 'rgba(76,201,255,0.35)';
    mmx.lineWidth = 1;
    mmx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // бонусы
    if (lastState) {
      for (const pu of lastState.powerups) {
        mmx.fillStyle = POWERUP_COLOR[pu.type] || '#fff';
        mmx.fillRect(pu.x * sx - 1.5, pu.y * sy - 1.5, 3, 3);
      }
    }
    for (const b of ents.bots) {
      mmx.fillStyle = (config && config.botTypes[b.type] && config.botTypes[b.type].color) || '#ff4d6d';
      mmx.fillRect(b.x * sx - 2, b.y * sy - 2, 4, 4);
    }
    for (const p of ents.players) {
      if (!p.alive) continue;
      mmx.fillStyle = p.me ? '#ffffff' : p.color;
      mmx.beginPath();
      mmx.arc(p.x * sx, p.y * sy, p.me ? 3.6 : 2.8, 0, Math.PI * 2);
      mmx.fill();
      if (p.me) {
        mmx.strokeStyle = 'rgba(255,255,255,0.8)';
        mmx.lineWidth = 1;
        const vw = canvas.clientWidth * sx / ZOOM, vh = canvas.clientHeight * sy / ZOOM;
        mmx.strokeRect(p.x * sx - vw / 2, p.y * sy - vh / 2, vw, vh);
      }
    }
  }

  /* ================= HUD ================= */

  let hudTimer = 0;
  function updateHud(s) {
    // бейджи
    el.modeBadge.textContent = s.mode === 'ffa' ? 'КАЖДЫЙ САМ ЗА СЕБЯ' : 'ВЫЖИВАНИЕ · КООП';
    if (s.mode === 'survival') {
      el.waveBadge.classList.add('show');
      el.waveBadge.textContent = `ВОЛНА ${s.wave}${s.waveState === 'active' ? ' · ' + s.waveBots + ' врагов' : ''}`;
    } else {
      el.waveBadge.classList.remove('show');
    }

    for (const btn of el.modeSwitch.querySelectorAll('.mbtn')) {
      btn.classList.toggle('active', btn.dataset.mode === s.mode);
      btn.classList.toggle('locked', btn.dataset.mode !== s.mode && s.hostId !== myId);
      btn.title = s.hostId === myId ? 'Вы — хост: сменить режим' : 'Голосовать за режим';
    }

    // витальные показатели
    const me = s.players.find((p) => p.id === myId);
    if (me) {
      el.hpFill.style.transform = `scaleX(${clamp(me.hp / me.mhp, 0, 1)})`;
      el.hpText.textContent = `ЗДОРОВЬЕ ${Math.max(0, Math.round(me.hp))} / ${me.mhp}`;
      el.shFill.style.transform = `scaleX(${clamp(me.sh / me.msh, 0, 1)})`;
      el.shText.textContent = `ЩИТ ${Math.max(0, Math.round(me.sh))} / ${me.msh}`;
      const cd = typeof me.dash === 'number' ? me.dash : 0;
      const dashPct = cd > 0 ? 1 - cd / 3 : 1;
      el.dashCd.style.setProperty('--dashP', dashPct);
      el.dashCd.classList.toggle('ready', cd <= 0);

      // buffs
      const buffs = [];
      if (me.tri > 0) buffs.push({ k: '⋔ ТРОЙНОЙ', c: '#ffd166', t: me.tri });
      if (me.rap > 0) buffs.push({ k: '⚡ ПЕРЕЗАРЯДКА', c: '#4cc9ff', t: me.rap });
      if (buffs.length) {
        el.buffRow.innerHTML = buffs.map((b) => `<div class="buff" style="color:${b.c}">${b.k} ${b.t.toFixed(0)}с</div>`).join('');
      } else el.buffRow.innerHTML = '';

      // респаун
      if (!me.alive) {
        el.respawnOverlay.classList.remove('hidden');
        el.rsTimer.textContent = Math.ceil(me.resp || RESPAWN_FALLBACK);
        if (!respawnShown) { respawnShown = true; Sound.death(); }
      } else if (respawnShown) {
        respawnShown = false;
        el.respawnOverlay.classList.add('hidden');
        Sound.respawn();
      }
    }

    // оверлей передышки
    if (s.mode === 'survival' && s.waveState === 'intermission') {
      el.waveOverlay.classList.remove('hidden');
      el.waveTitle.textContent = `ВОЛНА ${s.wave + 1}`;
      el.waveSub.textContent = `Передышка ${s.waveTimer.toFixed(1)} с · щиты восстановлены`;
      intermissionShown = true;
    } else if (intermissionShown) {
      intermissionShown = false;
      el.waveOverlay.classList.add('hidden');
    }

    // таблица лидеров (не чаще 5 раз/с)
    const now = performance.now();
    if (now - hudTimer > 200) {
      hudTimer = now;
      renderLeaderboard(s.lb, s.mode);
    }
  }

  const RESPAWN_FALLBACK = 3;

  function renderLeaderboard(rows, mode) {
    el.lbBody.innerHTML = rows.map((r, i) => {
      const medals = ['①', '②', '③'];
      const rank = medals[i] || (i + 1);
      const extra = mode === 'survival'
        ? `боты ${r.botKills} · ☠ ${r.deaths} · ${r.accuracy}%`
        : `☠ ${r.deaths} · ${r.accuracy}%`;
      const title = r.title ? `<span class="lb-title" style="color:${r.title.c}">${esc(r.title.t)}</span>` : '';
      return `<div class="lb-row ${r.id === myId ? 'me' : ''}">
        <span class="lb-rank">${rank}</span>
        <span class="lb-name"><span class="chip" style="background:${r.color};color:${r.color}"></span><span class="nm">${esc(r.name)}${title}</span></span>
        <span><span class="lb-score">${r.score}</span> <span class="lb-extra">${extra}</span></span>
      </div>`;
    }).join('');
  }

  /* ================= Игровой цикл ================= */

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    // частицы
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx -= p.vx * p.drag * dt;
      p.vy -= p.vy * p.drag * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= dt;
      r.r = lerp(r.r, r.maxR, 1 - Math.pow(0.001, dt));
      if (r.life <= 0) rings.splice(i, 1);
    }

    render();
    sendInput();
    requestAnimationFrame(frame);
  }

  /* ================= Ввод ================= */

  let inputAccum = 0;
  function sendInput() {
    if (!socket || !myId) return;
    const me = lastState && lastState.players.find((p) => p.id === myId);
    // прицел в мировых координатах
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const wx = camera.x + (input.mouseX - w / 2);
    const wy = camera.y + (input.mouseY - h / 2);
    let aim = input.aim;
    if (me) aim = Math.atan2(wy - me.y, wx - me.x);
    socket.emit('input', {
      up: input.up, down: input.down, left: input.left, right: input.right,
      fire: input.fire, aim,
    });
  }

  function bindInput() {
    const keymap = {
      KeyW: 'up', ArrowUp: 'up',
      KeyS: 'down', ArrowDown: 'down',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
    };

    window.addEventListener('keydown', (e) => {
      if (document.activeElement === el.nick) return;
      const k = keymap[e.code];
      if (k) { input[k] = true; e.preventDefault(); }
      if (e.code === 'Space') { e.preventDefault(); doDash(); }
      if (e.code === 'Tab') { e.preventDefault(); el.leaderboard.classList.toggle('wide'); el.hud.classList.toggle('table-open'); }
      if (e.code === 'KeyM') { toggleMute(); }
      if (e.code === 'Escape') { el.statsPanel.classList.add('hidden'); }
    });

    window.addEventListener('keyup', (e) => {
      const k = keymap[e.code];
      if (k) input[k] = false;
    });

    window.addEventListener('blur', () => {
      input.up = input.down = input.left = input.right = input.fire = false;
    });

    canvas.addEventListener('mousemove', (e) => { input.mouseX = e.clientX; input.mouseY = e.clientY; });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) input.fire = true;
      if (e.button === 2) doDash();
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) input.fire = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // тач-управление (упрощённое): стик слева, огонь справа
    bindTouch();
  }

  function doDash() {
    if (!socket || !myId) return;
    socket.emit('dash');
  }

  function bindTouch() {
    let moveId = null, moveStart = null;
    let aimId = null;

    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (t.clientX < window.innerWidth / 2 && moveId === null) {
          moveId = t.identifier; moveStart = { x: t.clientX, y: t.clientY };
        } else if (aimId === null) {
          aimId = t.identifier;
          input.mouseX = t.clientX; input.mouseY = t.clientY;
          input.fire = true;
        }
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === moveId && moveStart) {
          const dx = t.clientX - moveStart.x, dy = t.clientY - moveStart.y;
          input.left = dx < -22; input.right = dx > 22;
          input.up = dy < -22; input.down = dy > 22;
        } else if (t.identifier === aimId) {
          input.mouseX = t.clientX; input.mouseY = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });

    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === moveId) {
          moveId = null; input.up = input.down = input.left = input.right = false;
        } else if (t.identifier === aimId) {
          aimId = null; input.fire = false;
        }
      }
    };
    canvas.addEventListener('touchend', endTouch);
    canvas.addEventListener('touchcancel', endTouch);
  }

  function toggleMute() {
    const m = Sound.toggleMute();
    el.muteBtn.textContent = m ? '🔇' : '🔊';
    el.muteBtn.classList.toggle('off', m);
  }

  /* ================= Экран входа ================= */

  let chosenShip = 'vanguard';
  let chosenColor = COLORS[0];

  function shipSvg(ship, color) {
    const shape = SHIP_SHAPES[ship];
    const pts = shape.map(([x, y]) => `${32 + x * 0.9},${26 + y * 0.9}`).join(' ');
    return `<svg width="64" height="52" viewBox="0 0 64 52">
      <polygon points="${pts}" fill="${hexToRgba(color, 0.25)}" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" />
      <circle cx="32" cy="26" r="2.6" fill="${color}" />
    </svg>`;
  }

  function buildLoginUi() {
    el.shipGrid.innerHTML = Object.keys(SHIP_SHAPES).map((key) => {
      const label = { interceptor: 'INTERCEPTOR', vanguard: 'VANGUARD', spectre: 'SPECTRE' }[key];
      return `<div class="ship-card ${key === chosenShip ? 'sel' : ''}" data-ship="${key}">
        ${shipSvg(key, chosenColor)}
        <div class="sc-name">${label}</div>
        <div class="sc-stats">${SHIP_STATS[key]}</div>
      </div>`;
    }).join('');

    el.colorGrid.innerHTML = COLORS.map((c) => `<div class="swatch ${c === chosenColor ? 'sel' : ''}" data-color="${c}" style="background:${c};color:${c}"></div>`).join('');

    el.shipGrid.querySelectorAll('.ship-card').forEach((card) => {
      card.addEventListener('click', () => {
        chosenShip = card.dataset.ship;
        el.shipGrid.querySelectorAll('.ship-card').forEach((c) => c.classList.toggle('sel', c === card));
        refreshShipColors();
      });
    });

    el.colorGrid.querySelectorAll('.swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        chosenColor = sw.dataset.color;
        el.colorGrid.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s === sw));
        refreshShipColors();
      });
    });

    const stored = localStorage.getItem('cosmic_nick');
    if (stored) el.nick.value = stored;
    const stShip = localStorage.getItem('cosmic_ship');
    if (stShip && SHIP_SHAPES[stShip]) {
      chosenShip = stShip;
      el.shipGrid.querySelectorAll('.ship-card').forEach((c) => c.classList.toggle('sel', c.dataset.ship === chosenShip));
    }
    const stColor = localStorage.getItem('cosmic_color');
    if (stColor && COLORS.includes(stColor)) {
      chosenColor = stColor;
      el.colorGrid.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.color === chosenColor));
    }
    refreshShipColors();

    el.play.addEventListener('click', connect);
    el.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

    el.modeSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('.mbtn');
      if (!btn || !socket || !myId || !lastState) return;
      const mode = btn.dataset.mode;
      if (mode === lastState.mode) return;
      if (lastState.hostId === myId) socket.emit('setMode', { mode });
      else { socket.emit('voteMode', { mode }); toast('Голос отправлен. Нужна половина игроков.'); }
    });

    el.muteBtn.addEventListener('click', toggleMute);

    el.statsBtn.addEventListener('click', loadStats);
    el.statsClose.addEventListener('click', () => el.statsPanel.classList.add('hidden'));

    el.leaderboard.addEventListener('click', () => el.leaderboard.classList.toggle('wide'));
  }

  function refreshShipColors() {
    el.shipGrid.querySelectorAll('.ship-card').forEach((card) => {
      const svg = card.querySelector('svg');
      const tmp = document.createElement('div');
      tmp.innerHTML = shipSvg(card.dataset.ship, chosenColor);
      card.replaceChild(tmp.firstElementChild, svg);
    });
  }

  async function loadStats() {
    try {
      const res = await fetch('/api/stats');
      const list = await res.json();
      el.statsPanel.classList.remove('hidden');
      if (!list.length) {
        el.statsTableBody.innerHTML = '';
        el.statsEmpty.classList.remove('hidden');
        return;
      }
      el.statsEmpty.classList.add('hidden');
      const titles = (s) => {
        const acc = s.shots > 12 ? s.hits / s.shots : 0;
        if (s.bestStreak >= 8) return '<span style="color:#ff4d6d">Берсерк</span>';
        if (acc >= 0.45 && s.hits >= 25) return '<span style="color:#4cc9ff">Снайпер</span>';
        if (s.botKills >= 25) return '<span style="color:#ffa53b">Охотник на ботов</span>';
        if (s.deaths >= 8 && (s.kills + s.botKills) <= s.deaths * 0.4) return '<span style="color:#9aa7bd">Пушечное мясо</span>';
        if (s.kills >= 10) return '<span style="color:#ffd166">Ас</span>';
        if (s.bestWave >= 10) return '<span style="color:#b06bff">Ветеран волн</span>';
        return '<span style="color:#5d6b8f">—</span>';
      };
      el.statsTableBody.innerHTML = list.map((s) => `<tr>
        <td>${esc(s.name)}</td>
        <td>${s.kills}</td>
        <td>${s.botKills}</td>
        <td>${s.deaths}</td>
        <td>${s.kd}</td>
        <td>${s.accuracy}%</td>
        <td>${Math.round(s.damage)}</td>
        <td>${s.bestWave}</td>
        <td>${titles(s)}</td>
      </tr>`).join('');
    } catch (err) {
      toast('Не удалось загрузить статистику');
    }
  }

  /* ================= Соединение ================= */

  function connect() {
    const name = (el.nick.value || '').trim() || 'Пилот-' + Math.floor(Math.random() * 900 + 100);
    localStorage.setItem('cosmic_nick', name);
    localStorage.setItem('cosmic_ship', chosenShip);
    localStorage.setItem('cosmic_color', chosenColor);

    Sound.resume();
    el.play.disabled = true;
    el.play.textContent = 'ПОДКЛЮЧЕНИЕ…';

    socket = io();
    socket.on('connect', () => {
      socket.emit('join', { name, color: chosenColor, ship: chosenShip });
    });

    socket.on('joined', (cfg) => {
      myId = cfg.id;
      myInfo = { name, color: chosenColor, ship: chosenShip };
      config = cfg;
      serverMapW = cfg.map.w;
      serverMapH = cfg.map.h;
      camera.x = serverMapW / 2;
      camera.y = serverMapH / 2;
      buildStars();
      el.screen.classList.add('hidden');
      el.hud.classList.remove('hidden');
      toast(`Добро пожаловать, ${name}!`);
      if (cfg.hostId === myId) setTimeout(() => toast('Вы — хост. Можете менять режим.'), 1900);
    });

    socket.on('state', onState);
    socket.on('disconnect', () => {
      addKillFeed('Соединение потеряно. Перезагрузите страницу.', 'sys');
    });

    socket.on('connect_error', () => {
      el.play.disabled = false;
      el.play.textContent = 'ВОЙТИ НА АРЕНУ';
      toast('Сервер недоступен');
    });

    requestAnimationFrame(frame);
  }

  /* ================= Старт ================= */

  function boot() {
    resize();
    window.addEventListener('resize', () => { resize(); buildStars(); });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    minimap.width = MM_W * dpr;
    minimap.height = MM_H * dpr;
    mmx.scale(dpr, dpr);
    bindInput();
    buildLoginUi();
    buildStars();
    input.mouseX = window.innerWidth / 2;
    input.mouseY = window.innerHeight / 2;
  }

  boot();
})();
