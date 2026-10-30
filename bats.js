(function () {
  'use strict';

  var CONFIG = {
    maxBats: window.innerWidth < 600 ? 2 : 4, // max bats on screen at once
    spawnMin: 2500,       // ms between spawns (min)
    spawnMax: 7000,       // ms between spawns (max)
    sizeMin: 28,          // bat width in px (min)
    sizeMax: 72,          // bat width in px (max)
    flightMin: 6000,      // ms to cross the screen (min)
    flightMax: 11000,     // ms to cross the screen (max)
    color: '#151515',
    eyeColor: '#ff7a00',
    zIndex: 9999,
    sound: true,          // flutter + squeak when a bat is hovered/tapped
    volume: 0.25,         // master volume 0..1
    flutterVolume: 0.25,  // wing flutter level relative to squeaks, 0 = off
    soundCooldown: 1500,  // ms before the same bat can make noise again
    scareBoost: 2.2,      // speed multiplier once a bat is hovered
    activeUntil: '2026-11-01T00:00:00' // auto-disable after Halloween
  };

  if (window.__halloweenBats) return;
  if (CONFIG.activeUntil && new Date() > new Date(CONFIG.activeUntil)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var CSS =
    '.hb-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:' + CONFIG.zIndex + '}' +
    '.hb-bat{position:absolute;left:0;top:0;will-change:transform}' +
    '.hb-bat svg{display:block;width:100%;height:auto;overflow:visible}' +
    '.hb-wing{transform-box:view-box;transform-origin:50px 24px;' +
      'animation:hb-flap var(--hb-flap,.16s) ease-in-out infinite alternate}' +
    '@keyframes hb-flap{from{transform:scaleY(1)}to{transform:scaleY(-.45)}}' +
    '@media print{.hb-layer{display:none}}';

  var SVG =
    '<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<g fill="' + CONFIG.color + '">' +
        '<path class="hb-wing" d="M50 22C40 10 25 8 5 14C12 18 14 22 12 28C18 24 24 26 26 32C32 26 40 28 46 30Z"/>' +
        '<path class="hb-wing" d="M50 22C60 10 75 8 95 14C88 18 86 22 88 28C82 24 76 26 74 32C68 26 60 28 54 30Z"/>' +
        '<ellipse cx="50" cy="28" rx="5" ry="9"/>' +
        '<circle cx="50" cy="19" r="5"/>' +
        '<polygon points="45.5,17 46.5,9 49,15"/>' +
        '<polygon points="51,15 53.5,9 54.5,17"/>' +
      '</g>' +
      '<circle cx="48" cy="19" r="1" fill="' + CONFIG.eyeColor + '"/>' +
      '<circle cx="52" cy="19" r="1" fill="' + CONFIG.eyeColor + '"/>' +
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

  // Wing flutter: soft low-passed noise "whoosh" pulsed at wing-beat rate, fading out.
  function flutter(t0) {
    var dur = rand(0.25, 0.4);
    var beat = 1 / rand(12, 16);

    var src = audio.createBufferSource();
    src.buffer = noiseBuf;
    var lp = audio.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = rand(350, 600);
    lp.Q.value = 0.5;
    var g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t0);

    for (var i = 0; i * beat < dur; i++) {
      var bt = t0 + i * beat;
      var level = CONFIG.flutterVolume * (1 - (i * beat) / dur);
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.linearRampToValueAtTime(level, bt + beat * 0.4);
      g.gain.linearRampToValueAtTime(0.0001, bt + beat * 0.95);
    }

    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // Squeak: short, high, up-then-down pitch chirp.
  function squeak(t0) {
    var f = rand(2600, 3600);
    var len = rand(0.04, 0.08);

    var osc = audio.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 0.8, t0);
    osc.frequency.exponentialRampToValueAtTime(f * 1.4, t0 + len * 0.4);
    osc.frequency.exponentialRampToValueAtTime(f * 0.9, t0 + len);

    var g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);

    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + len + 0.02);
  }

  function batSound() {
    if (!audio || audio.state !== 'running') return;
    var t = audio.currentTime + 0.01;
    if (CONFIG.flutterVolume > 0) flutter(t);
    var st = t + rand(0, 0.1);
    for (var n = 1 + Math.floor(Math.random() * 3); n > 0; n--) {
      squeak(st);
      st += rand(0.07, 0.13);
    }
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

  /* ---------- bats ---------- */

  function spawn() {
    if (stopped || document.hidden || active >= CONFIG.maxBats) return;

    var vw = window.innerWidth, vh = window.innerHeight;
    var w = rand(CONFIG.sizeMin, CONFIG.sizeMax);
    var depth = (w - CONFIG.sizeMin) / (CONFIG.sizeMax - CONFIG.sizeMin); // 0 = far, 1 = near

    var el = document.createElement('div');
    el.className = 'hb-bat';
    el.style.width = w + 'px';
    el.style.opacity = (0.55 + depth * 0.45).toFixed(2);
    el.style.setProperty('--hb-flap', rand(0.12, 0.2).toFixed(2) + 's');
    el.innerHTML = SVG;
    layer.appendChild(el);
    active++;

    var ltr = Math.random() < 0.5;
    var x0 = ltr ? -w : vw, x1 = ltr ? vw : -w;
    var y0 = rand(0.05, 0.6) * vh, y1 = rand(0.05, 0.6) * vh;
    var amp = rand(15, 60);                 // vertical wobble in px
    var waves = rand(1.5, 4);               // wobble cycles per flight
    var phase = rand(0, Math.PI * 2);
    var dur = rand(CONFIG.flightMin, CONFIG.flightMax) * (1.4 - depth * 0.4); // far bats fly slower
    var dir = ltr ? 1 : -1;
    var t = 0, last = null, speed = 1, quietUntil = 0;

    function step(now) {
      if (stopped) return;
      if (last === null) last = now;
      t += Math.min(now - last, 50) * speed; // clamp so we don't jump after a hidden tab
      last = now;

      var p = t / dur;
      if (p >= 1) {
        el.remove();
        active--;
        return;
      }

      var a = p * waves * Math.PI * 2 + phase;
      var x = x0 + (x1 - x0) * p;
      var y = y0 + (y1 - y0) * p + amp * Math.sin(a);
      var rot = 14 * Math.cos(a) * dir;

      // Hit box covers the visible bat (y 8..37 of the 100x50 viewBox), with a little padding.
      if (pointer && now >= quietUntil &&
          pointer.x >= x && pointer.x <= x + w &&
          pointer.y >= y + w * 0.04 && pointer.y <= y + w * 0.41) {
        quietUntil = now + CONFIG.soundCooldown;
        batSound();
        speed = CONFIG.scareBoost;
        el.style.setProperty('--hb-flap', '0.07s');
      }

      el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + rot + 'deg)';
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
    layer.className = 'hb-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    LISTENERS.forEach(function (l) {
      document.addEventListener(l[0], l[1], { capture: true, passive: true });
    });

    setTimeout(spawn, 800);
    schedule();
  }

  window.__halloweenBats = {
    stop: function () {
      stopped = true;
      clearTimeout(timer);
      LISTENERS.forEach(function (l) {
        document.removeEventListener(l[0], l[1], { capture: true });
      });
      if (audio) audio.close();
      if (layer) layer.remove();
      if (styleEl) styleEl.remove();
      delete window.__halloweenBats;
    }
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
