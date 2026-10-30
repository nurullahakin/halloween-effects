(function () {
  'use strict';

  var CONFIG = {
    maxWitches: window.innerWidth < 600 ? 2 : 3, // max witches on screen at once
    firstDelay: 3000,     // ms before the first witch
    spawnMin: 4000,       // ms between spawns (min)
    spawnMax: 10000,      // ms between spawns (max)
    sizeMin: window.innerWidth < 600 ? 50 : 60,   // witch width in px (min)
    sizeMax: window.innerWidth < 600 ? 110 : 150, // witch width in px (max)
    flightMin: 9000,      // ms to cross the screen (min)
    flightMax: 15000,     // ms to cross the screen (max)
    color: '#151515',
    accentColor: '#ff7a00',
    sparkles: true,       // sparkle trail from the broom
    sparkleColors: ['#ff7a00', '#b46cff', '#7dff6a'],
    zIndex: 2147483646, // just under the bats
    sound: true,          // cackle + whoosh when a witch is hovered/tapped
    volume: 0.25,         // master volume 0..1
    cackleVolume: 0.8,    // cackle level, 0 = off
    whooshVolume: 0.3,    // broom whoosh level, 0 = off
    soundCooldown: 4000,  // ms before the same witch can make noise again
    scareBoost: 1.8,      // speed multiplier once a witch is hovered
    activeUntil: '2026-11-01T00:00:00' // auto-disable after Halloween
  };

  if (window.__halloweenWitches) return;
  if (CONFIG.activeUntil && new Date() > new Date(CONFIG.activeUntil)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var CSS =
    '.hw-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:' + CONFIG.zIndex + '}' +
    '.hw-witch{position:absolute;left:0;top:0;will-change:transform}' +
    '.hw-witch svg{display:block;width:100%;height:auto;overflow:visible;' +
      'animation:hw-bob 1.4s ease-in-out infinite alternate}' +
    '.hw-cape{transform-box:view-box;transform-origin:68px 23px;' +
      'animation:hw-cape var(--hw-cape,.35s) ease-in-out infinite alternate}' +
    '.hw-hair{transform-box:view-box;transform-origin:68px 18px;' +
      'animation:hw-cape var(--hw-cape,.35s) ease-in-out infinite alternate-reverse}' +
    '.hw-spark{position:absolute;left:0;top:0;width:5px;height:5px;border-radius:50%;' +
      'background:var(--c);box-shadow:0 0 6px 2px var(--c);animation:hw-spark .9s ease-out forwards}' +
    '@keyframes hw-bob{from{transform:translateY(-3%)}to{transform:translateY(3%)}}' +
    '@keyframes hw-cape{from{transform:skewY(-6deg)}to{transform:skewY(5deg) scaleX(.93)}}' +
    '@keyframes hw-spark{' +
      'from{opacity:1;transform:translate(var(--x),var(--y)) scale(1)}' +
      'to{opacity:0;transform:translate(calc(var(--x) + var(--dx)),calc(var(--y) + var(--dy))) scale(.2)}}' +
    '@media print{.hw-layer{display:none}}';

  // Faces right; flipped with scaleX(-1) when flying left.
  var SVG =
    '<svg viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<g fill="' + CONFIG.color + '">' +
        '<path class="hw-cape" d="M68 23C58 22 48 26 38 21C43 28 45 31 40 35C49 34 56 37 61 39Z"/>' +
        '<path class="hw-hair" d="M68 16C62 18 57 21 50 20C56 23 62 23 67 21Z"/>' +
        '<path d="M28 44L116 36.5L116.3 38.5L28.3 46Z"/>' +
        '<path d="M30 41L5 34L10 40L1 42L10 45.5L4 52L30 47Z"/>' +
        '<path d="M60 42C58 32 61 25 68 22L75 24C78 30 78 38 75 42Z"/>' +
        '<path d="M70 41L78 50L84 50L84 52.5L74 52.5L66 43Z"/>' +
        '<path d="M72 27L89 37L87 40L70 31Z"/>' +
        '<circle cx="72" cy="18" r="5"/>' +
        '<path d="M76 16.5L82 19.5L76 20.5Z"/>' +
        '<ellipse cx="71" cy="13.5" rx="10" ry="2" transform="rotate(-6 71 13.5)"/>' +
        '<path d="M63.5 13Q63 7 60 3.5Q58 1.5 54.5 2.5Q59.5 -2 66 0.5Q71 5 78.5 12Z"/>' +
      '</g>' +
      '<rect x="28" y="40.5" width="3" height="7" fill="' + CONFIG.accentColor + '" transform="rotate(-4 29.5 44)"/>' +
      '<circle cx="74.5" cy="17" r="0.9" fill="' + CONFIG.accentColor + '"/>' +
    '</svg>';

  var layer, styleEl, timer, active = 0, stopped = false;
  var pointer = null; // last known pointer position in viewport coords

  function rand(min, max) { return min + Math.random() * (max - min); }

  /* ---------- sound (Web Audio, no files) ---------- */

  var audio = null, master, noiseBuf;

  // Browsers only allow audio after a user gesture, so this runs on first click/tap/key.
  function ensureAudio() {
    if (!CONFIG.sound) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) {
      audio = new AC();
      master = audio.createGain();
      master.gain.value = CONFIG.volume;
      master.connect(audio.destination);

      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      var data = noiseBuf.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audio.state === 'suspended') audio.resume();
  }

  var GRIT_CURVE = (function () {
    var c = new Float32Array(1024);
    for (var i = 0; i < c.length; i++) c[i] = Math.tanh(3 * (i / 512 - 1));
    return c;
  })();

  // Evil cackle in three parts: a rising "aaah" wind-up, a rapid burst of shrill
  // "hee-hee-hee" falling in pitch, then a long warbling "heeeee".
  // Voice = saw + square (shared pitch), soft-clipped for grit, a low square wave
  // wobbling the level for a raspy crackle, nasal "ee" formants, and a short echo.
  // Returns the time it ends.
  function cackle(t0) {
    var level = CONFIG.cackleVolume;
    var f = rand(650, 800);

    var pitch = audio.createConstantSource();
    pitch.offset.setValueAtTime(f, t0);
    var vib = audio.createOscillator();
    vib.frequency.value = 6.5;
    var vibDepth = audio.createGain(); // in cents
    vib.connect(vibDepth);

    var sources = [];
    var voice = audio.createGain();
    [['sawtooth', 0, 1], ['square', 8, 0.4]].forEach(function (o) {
      var osc = audio.createOscillator();
      osc.type = o[0];
      osc.frequency.value = 0;
      osc.detune.value = o[1];
      pitch.connect(osc.frequency);
      vibDepth.connect(osc.detune);
      var g = audio.createGain();
      g.gain.value = o[2];
      osc.connect(g);
      g.connect(voice);
      sources.push(osc);
    });

    var grit = audio.createWaveShaper();
    grit.curve = GRIT_CURVE;
    voice.connect(grit);

    var rasp = audio.createGain();
    rasp.gain.value = 0.75;
    var creak = audio.createOscillator();
    creak.type = 'square';
    creak.frequency.value = rand(40, 55);
    var creakDepth = audio.createGain();
    creakDepth.gain.value = 0.25;
    creak.connect(creakDepth);
    creakDepth.connect(rasp.gain);
    grit.connect(rasp);

    var env = audio.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    [[350, 1, 6], [1000, 0.4, 8], [2500, 0.9, 10], [3100, 0.5, 10]].forEach(function (fm) {
      var bp = audio.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fm[0];
      bp.Q.value = fm[2];
      var g = audio.createGain();
      g.gain.value = fm[1];
      rasp.connect(bp);
      bp.connect(g);
      g.connect(env);
    });

    var delay = audio.createDelay(1);
    delay.delayTime.value = 0.11;
    var feedback = audio.createGain();
    feedback.gain.value = 0.2;
    var damp = audio.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2500;
    var wet = audio.createGain();
    wet.gain.value = 0.35;
    env.connect(master);
    env.connect(delay);
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    damp.connect(wet);
    wet.connect(master);

    var P = pitch.offset, E = env.gain, V = vibDepth.gain;
    var st = t0;

    // 1) wind-up "aaah"
    var len = rand(0.1, 0.14);
    V.setValueAtTime(100, st);
    P.setValueAtTime(f * 0.75, st);
    P.exponentialRampToValueAtTime(f * 1.35, st + len);
    E.setValueAtTime(0.0001, st);
    E.linearRampToValueAtTime(level, st + 0.04);
    E.setValueAtTime(level, st + len - 0.05);
    E.linearRampToValueAtTime(0.0001, st + len);
    st += len + 0.03;

    // 2) rapid "hee-hee-hee", each up-then-down, drifting lower
    V.setValueAtTime(25, st);
    for (var i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) {
      var p = f * 1.3 * (1 - i * 0.035) * rand(0.95, 1.05);
      len = rand(0.055, 0.07);
      P.setValueAtTime(p * 0.9, st);
      P.linearRampToValueAtTime(p * 1.1, st + len * 0.3);
      P.linearRampToValueAtTime(p * 0.85, st + len);
      E.setValueAtTime(0.0001, st);
      E.linearRampToValueAtTime(level, st + 0.008);
      E.linearRampToValueAtTime(level * 0.6, st + len * 0.7);
      E.linearRampToValueAtTime(0.0001, st + len);
      breath(st, level * 0.2);
      st += len + 0.025;
    }

    // 3) long warbling "heeeee", up then down
    len = rand(0.18, 0.25);
    st += 0.02;
    V.setValueAtTime(150, st);
    P.setValueAtTime(f * 1.2, st);
    P.exponentialRampToValueAtTime(f * 1.5, st + len * 0.35);
    P.exponentialRampToValueAtTime(f * 0.9, st + len);
    E.setValueAtTime(0.0001, st);
    E.linearRampToValueAtTime(level, st + 0.05);
    E.setValueAtTime(level * 0.9, st + len * 0.6);
    E.linearRampToValueAtTime(0.0001, st + len);
    breath(st, level * 0.2);
    st += len;

    sources.concat([pitch, vib, creak]).forEach(function (s) {
      s.start(t0);
      s.stop(st + 0.05);
    });
    // break the echo feedback loop once it has died out
    setTimeout(function () { delay.disconnect(); }, (st - t0 + 2) * 1000);

    return st;
  }

  function breath(t0, level) {
    var src = audio.createBufferSource();
    src.buffer = noiseBuf;
    var hp = audio.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    var g = audio.createGain();
    g.gain.setValueAtTime(level, t0);
    g.gain.linearRampToValueAtTime(0.0001, t0 + 0.03);
    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + 0.04);
  }

  // Whoosh: noise through a band-pass sweeping up and back down.
  function whoosh(t0) {
    var dur = rand(0.6, 0.8);

    var src = audio.createBufferSource();
    src.buffer = noiseBuf;
    var bp = audio.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1;
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(1400, t0 + dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(400, t0 + dur);
    var g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(CONFIG.whooshVolume, t0 + dur * 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  var cackleUntil = 0; // one cackle at a time across all witches

  function witchSound() {
    if (!audio || audio.state !== 'running') return;
    var t = audio.currentTime + 0.01;
    if (CONFIG.whooshVolume > 0) whoosh(t);
    if (CONFIG.cackleVolume > 0 && t >= cackleUntil) cackleUntil = cackle(t + rand(0.05, 0.15));
  }

  /* ---------- pointer tracking (layer stays click-through) ---------- */

  function onMove(e) { pointer = { x: e.clientX, y: e.clientY }; }
  function onDown(e) { ensureAudio(); onMove(e); }
  function onUp(e) { if (e.pointerType !== 'mouse') pointer = null; } // touch: no lingering "hover"
  function onOut(e) { if (!e.relatedTarget) pointer = null; }         // mouse left the window
  function onKey() { ensureAudio(); }

  var LISTENERS = [
    ['pointermove', onMove],
    ['pointerdown', onDown],
    ['pointerup', onUp],
    ['pointercancel', onUp],
    ['mouseout', onOut],
    ['keydown', onKey]
  ];

  /* ---------- witches ---------- */

  function sparkle(x, y, dir) {
    var s = document.createElement('div');
    var c = CONFIG.sparkleColors[Math.floor(Math.random() * CONFIG.sparkleColors.length)];
    s.className = 'hw-spark';
    s.style.setProperty('--c', c);
    s.style.setProperty('--x', x + rand(-3, 3) + 'px');
    s.style.setProperty('--y', y + rand(-3, 3) + 'px');
    s.style.setProperty('--dx', -dir * rand(10, 30) + 'px');
    s.style.setProperty('--dy', rand(10, 35) + 'px');
    s.addEventListener('animationend', function () { s.remove(); });
    layer.appendChild(s);
  }

  function spawn() {
    if (stopped || document.hidden || active >= CONFIG.maxWitches) return;

    var vw = window.innerWidth, vh = window.innerHeight;
    var w = rand(CONFIG.sizeMin, CONFIG.sizeMax);
    var depth = (w - CONFIG.sizeMin) / (CONFIG.sizeMax - CONFIG.sizeMin); // 0 = far, 1 = near

    var el = document.createElement('div');
    el.className = 'hw-witch';
    el.style.width = w + 'px';
    el.style.opacity = (0.6 + depth * 0.4).toFixed(2);
    el.style.zIndex = Math.round(w); // nearer (bigger) witches draw on top
    el.innerHTML = SVG;
    layer.appendChild(el);
    active++;

    var ltr = Math.random() < 0.5;
    var dir = ltr ? 1 : -1;
    var x0 = ltr ? -w : vw, x1 = ltr ? vw : -w;
    var y0 = rand(0.08, 0.5) * vh, y1 = rand(0.08, 0.5) * vh;
    var amp = rand(10, 30);                 // vertical wobble in px
    var waves = rand(1, 2);                 // wobble cycles per flight
    var phase = rand(0, Math.PI * 2);
    var dur = rand(CONFIG.flightMin, CONFIG.flightMax) * (1.4 - depth * 0.4); // far witches fly slower
    var t = 0, last = null, speed = 1, quietUntil = 0;
    var scared = false, lift = 0, nextSpark = 0;

    function step(now) {
      if (stopped) return;
      if (last === null) last = now;
      var dt = Math.min(now - last, 50); // clamp so we don't jump after a hidden tab
      last = now;
      t += dt * speed;
      if (scared) lift += dt * 0.15;     // climb away ~150px/s

      var p = t / dur;
      if (p >= 1 || lift > vh) {
        el.remove();
        active--;
        return;
      }

      var a = p * waves * Math.PI * 2 + phase;
      var x = x0 + (x1 - x0) * p;
      var y = y0 + (y1 - y0) * p + amp * Math.sin(a) - lift;
      var rot = (8 * Math.cos(a) - (scared ? 12 : 0)) * dir;

      // Hit box covers witch + broom (100x50-ish of the 120x60 viewBox).
      if (pointer && now >= quietUntil &&
          pointer.x >= x + w * 0.05 && pointer.x <= x + w * 0.95 &&
          pointer.y >= y && pointer.y <= y + w * 0.45) {
        quietUntil = now + CONFIG.soundCooldown;
        witchSound();
        scared = true;
        speed = CONFIG.scareBoost;
        el.style.setProperty('--hw-cape', '0.15s');
      }

      if (CONFIG.sparkles && now >= nextSpark) {
        nextSpark = now + (scared ? 30 : 70);
        sparkle(x + (ltr ? w * 0.04 : w * 0.96), y + w * 0.35, dir);
      }

      el.style.transform =
        'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + rot + 'deg) scaleX(' + dir + ')';
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function schedule() {
    timer = setTimeout(function () {
      spawn();
      schedule();
    }, rand(CONFIG.spawnMin, CONFIG.spawnMax));
  }

  function start() {
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    layer = document.createElement('div');
    layer.className = 'hw-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    LISTENERS.forEach(function (l) {
      document.addEventListener(l[0], l[1], { capture: true, passive: true });
    });

    setTimeout(spawn, CONFIG.firstDelay);
    schedule();
  }

  window.__halloweenWitches = {
    stop: function () {
      stopped = true;
      clearTimeout(timer);
      LISTENERS.forEach(function (l) {
        document.removeEventListener(l[0], l[1], { capture: true });
      });
      if (audio) audio.close();
      if (layer) layer.remove();
      if (styleEl) styleEl.remove();
      delete window.__halloweenWitches;
    }
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
