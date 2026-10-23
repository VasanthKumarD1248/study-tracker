'use strict';

// Flowing starfield behind the focus clock: three parallax layers drifting diagonally,
// soft twinkle, and the odd shooting star. Runs only while the focus screen is open.
const Starfield = (() => {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  const COLORS = ['#b3ecff', '#8fe1ff', '#6fd3ff', '#4fc3ff'];
  // density = stars per CSS pixel², speed = CSS px per second at full speed
  const LAYERS = [
    { density: 0.00016, size: [0.6, 1.1], speed: 8, alpha: 0.65 },
    { density: 0.00007, size: [1.0, 1.8], speed: 20, alpha: 0.9 },
    { density: 0.00002, size: [1.8, 3.0], speed: 42, alpha: 1 },
  ];
  const ANGLE = 0.22;                       // radians below horizontal, left → right
  const DX = Math.cos(ANGLE), DY = Math.sin(ANGLE);
  const SDX = Math.cos(0.5), SDY = Math.sin(0.5); // shooting stars fall a little steeper
  const RUN_SPEED = 1, PAUSE_SPEED = 0.12;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // One pre-rendered glow per color; drawing images is far cheaper than gradients per star.
  const sprites = COLORS.map((color) => {
    const c = document.createElement('canvas');
    const s = 64;
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, '#f0fbff');
    grd.addColorStop(0.08, color);
    grd.addColorStop(0.22, `${color}bb`);
    grd.addColorStop(0.5, `${color}33`);
    grd.addColorStop(1, `${color}00`);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  });

  let stars = [];
  let shooting = null;
  let nextShot = 0;
  let w = 0, h = 0;
  let raf = 0, last = 0;
  let speed = RUN_SPEED, target = RUN_SPEED;

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = [];
    LAYERS.forEach((L, layer) => {
      const n = Math.round(w * h * L.density);
      for (let i = 0; i < n; i++) {
        stars.push({
          x: Math.random() * w, y: Math.random() * h, layer,
          r: rand(...L.size),
          sprite: sprites[(Math.random() * sprites.length) | 0],
          phase: Math.random() * Math.PI * 2,
          twinkle: rand(0.6, 2.2),
        });
      }
    });
  }

  function launchShootingStar(now) {
    const len = rand(120, 220);
    shooting = { x: rand(-0.1, 0.6) * w, y: rand(-0.1, 0.4) * h, len, life: 0, dur: rand(0.7, 1.1), v: rand(700, 1000) };
    nextShot = now + rand(7, 15);
  }

  function draw(t, dt) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const s of stars) {
      const L = LAYERS[s.layer];
      const step = L.speed * speed * dt;
      s.x += step * DX;
      s.y += step * DY;
      if (s.x > w + 8) { s.x = -8; s.y = Math.random() * h; }
      if (s.y > h + 8) { s.y = -8; s.x = Math.random() * w; }
      const a = L.alpha * (0.6 + 0.4 * Math.sin(t * s.twinkle + s.phase));
      const size = s.r * 9;
      ctx.globalAlpha = a;
      ctx.drawImage(s.sprite, s.x - size / 2, s.y - size / 2, size, size);
    }

    if (target === RUN_SPEED && !shooting && t > nextShot) launchShootingStar(t);
    if (shooting) {
      const sh = shooting;
      sh.life += dt;
      sh.x += sh.v * SDX * dt;
      sh.y += sh.v * SDY * dt;
      const fade = Math.sin(Math.min(sh.life / sh.dur, 1) * Math.PI);
      const tx = sh.x - sh.len * SDX, ty = sh.y - sh.len * SDY;
      const grd = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
      grd.addColorStop(0, 'rgba(220,245,255,0.95)');
      grd.addColorStop(1, 'rgba(120,210,255,0)');
      ctx.globalAlpha = fade;
      ctx.strokeStyle = grd;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      if (sh.life >= sh.dur) shooting = null;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(ms) {
    const t = ms / 1000;
    const dt = last ? Math.min(t - last, 0.05) : 0; // clamp so a dropped frame never makes stars jump
    last = t;
    speed += (target - speed) * Math.min(1, dt * 1.5); // ease between running and paused
    draw(t, dt);
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { if (raf || reducedMotion) { resize(); if (reducedMotion) draw(0, 0); } });

  return {
    start() {
      if (raf) return;
      resize();
      nextShot = performance.now() / 1000 + rand(3, 6);
      if (reducedMotion) { draw(0, 0); return; }
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      shooting = null;
    },
    setRunning(isRunning) {
      target = isRunning ? RUN_SPEED : PAUSE_SPEED;
    },
  };
})();
