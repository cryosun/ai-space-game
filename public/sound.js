'use strict';

/**
 * Cosmic Arena — процедурный звуковой движок (Web Audio API).
 * Никаких внешних файлов: всё синтезируется осцилляторами, шумом и фильтрами.
 */

const Sound = (() => {
  let ctx = null;
  let master = null;
  let muted = false;
  let noiseBuffer = null;
  let started = false;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);

    // pre-render white noise (1 s)
    const len = ctx.sampleRate;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  function resume() {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    started = true;
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  function tone({ freq = 440, freqEnd = null, type = 'sine', dur = 0.15, gain = 0.3, attack = 0.005, filter = null, detune = 0 }) {
    if (!ctx || muted) return;
    const t = now();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (detune) osc.detune.setValueAtTime(detune, t);
    if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.setValueAtTime(filter.freq || 1200, t);
      if (filter.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, filter.freqEnd), t + dur);
      f.Q.value = filter.q || 1;
      node.connect(f);
      f.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise({ dur = 0.4, gain = 0.4, freq = 1200, freqEnd = 120, type = 'lowpass', q = 1 }) {
    if (!ctx || muted) return;
    const t = now();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /* ---------------- public API ---------------- */

  return {
    init,
    resume,

    get muted() { return muted; },

    toggleMute() {
      init();
      muted = !muted;
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.35, now(), 0.02);
      return muted;
    },

    // Короткий спадающий импульс лазера
    laser(vol = 1) {
      init();
      tone({ freq: 1180 + Math.random() * 120, freqEnd: 220, type: 'square', dur: 0.09, gain: 0.12 * vol, filter: { type: 'lowpass', freq: 2400, freqEnd: 600 } });
      tone({ freq: 2400, freqEnd: 900, type: 'sawtooth', dur: 0.05, gain: 0.05 * vol });
    },

    enemyLaser(vol = 1) {
      init();
      tone({ freq: 620, freqEnd: 180, type: 'sawtooth', dur: 0.1, gain: 0.06 * vol, filter: { type: 'lowpass', freq: 1400, freqEnd: 400 } });
    },

    // Попадание по щиту — звонкий металлический "тик"
    shieldHit() {
      init();
      tone({ freq: 1500, freqEnd: 900, type: 'triangle', dur: 0.1, gain: 0.14 });
      tone({ freq: 2200, freqEnd: 1600, type: 'sine', dur: 0.06, gain: 0.06 });
    },

    // Попадание по корпусу — глухой удар
    hullHit() {
      init();
      tone({ freq: 200, freqEnd: 70, type: 'square', dur: 0.12, gain: 0.16, filter: { type: 'lowpass', freq: 900, freqEnd: 200 } });
      noise({ dur: 0.09, gain: 0.12, freq: 900, freqEnd: 150 });
    },

    // Взрыв — белый шум через low-pass
    explosion(vol = 1) {
      init();
      noise({ dur: 0.55, gain: 0.5 * vol, freq: 1800, freqEnd: 90, q: 0.8 });
      tone({ freq: 140, freqEnd: 40, type: 'sine', dur: 0.5, gain: 0.3 * vol });
      tone({ freq: 90, freqEnd: 30, type: 'triangle', dur: 0.65, gain: 0.18 * vol });
    },

    smallExplosion(vol = 0.6) {
      init();
      noise({ dur: 0.28, gain: 0.3 * vol, freq: 2200, freqEnd: 200 });
      tone({ freq: 260, freqEnd: 60, type: 'sine', dur: 0.25, gain: 0.16 * vol });
    },

    // Рывок — whoosh + восходящий тон
    dash() {
      init();
      noise({ dur: 0.3, gain: 0.22, freq: 400, freqEnd: 3200, type: 'bandpass', q: 1.4 });
      tone({ freq: 160, freqEnd: 720, type: 'sawtooth', dur: 0.28, gain: 0.09, filter: { type: 'lowpass', freq: 600, freqEnd: 2600 } });
    },

    // Подбор бонуса — восходящее арпеджио
    pickup() {
      init();
      const base = 520;
      [0, 4, 7, 12].forEach((semi, i) => {
        const f = base * Math.pow(2, semi / 12);
        setTimeout(() => tone({ freq: f, freqEnd: f * 1.4, type: 'triangle', dur: 0.13, gain: 0.14 }), i * 55);
      });
    },

    waveStart() {
      init();
      [0, 7, 12, 19].forEach((semi, i) => {
        const f = 220 * Math.pow(2, semi / 12);
        setTimeout(() => tone({ freq: f, freqEnd: f, type: 'square', dur: 0.3, gain: 0.1, filter: { type: 'lowpass', freq: 1800 } }), i * 130);
      });
    },

    respawn() {
      init();
      tone({ freq: 300, freqEnd: 900, type: 'sine', dur: 0.25, gain: 0.12 });
    },

    achievement() {
      init();
      [0, 5, 9, 14, 17].forEach((semi, i) => {
        const f = 660 * Math.pow(2, semi / 12);
        setTimeout(() => tone({ freq: f, freqEnd: f * 1.2, type: 'triangle', dur: 0.22, gain: 0.12 }), i * 70);
      });
    },

    death() {
      init();
      tone({ freq: 420, freqEnd: 60, type: 'sawtooth', dur: 0.7, gain: 0.2, filter: { type: 'lowpass', freq: 1400, freqEnd: 200 } });
      noise({ dur: 0.6, gain: 0.28, freq: 1200, freqEnd: 80 });
    },
  };
})();
