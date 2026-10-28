// Hologram effects: boot sequence, particles + scan beam, wireframe globe,
// radar, data stream, typewriter replies and mouse parallax.
(() => {
  const $ = s => document.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CYAN = '95, 227, 255';

  // Canvas sized to its CSS box at device resolution.
  function fit(c) {
    const d = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    return { g, w, h };
  }

  // ------------------------------------------------------------ boot sequence
  function bootSequence() {
    const el = $('#boot');
    if (!el) return Promise.resolve();
    if (reduce) { el.remove(); document.body.classList.add('booted'); return Promise.resolve(); }
    const lines = [
      'INITIALIZING J.A.R.V.I.S. CORE', 'LOADING NEURAL INTERFACE', 'CALIBRATING VOICE MATRIX',
      'ESTABLISHING SECURE UPLINK', 'SYNCING HOLOGRAPHIC DISPLAY', 'ALL SYSTEMS NOMINAL',
    ];
    // app.js fills in the name once settings load; the last line is read when it appears.
    const lastLine = () => (window.holo?.userName ? `WELCOME BACK, ${window.holo.userName.toUpperCase()}` : lines[lines.length - 1]);
    const list = el.querySelector('.boot-lines');
    const bar = el.querySelector('.boot-bar i');
    const pct = el.querySelector('.boot-pct');
    return new Promise(resolve => {
      let i = 0, ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        el.classList.add('done');
        document.body.classList.add('booted');
        setTimeout(() => { el.remove(); resolve(); }, 650);
      };
      el.addEventListener('click', finish);
      const step = () => {
        if (ended) return;
        if (i < lines.length) {
          const row = document.createElement('div');
          const last = i === lines.length - 1;
          row.innerHTML = `<span></span><b>${last ? 'READY' : 'OK'}</b>`;
          row.querySelector('span').textContent = last ? lastLine() : lines[i].replace('J.A.R.V.I.S.', window.holo?.brand || 'J.A.R.V.I.S.');
          list.append(row);
          i++;
          const p = Math.round((i / lines.length) * 100);
          bar.style.width = p + '%';
          pct.textContent = p + '%';
          setTimeout(step, 260 + Math.random() * 180);
        } else setTimeout(finish, 420);
      };
      setTimeout(step, 450);
    });
  }

  // ------------------------------------------------------------ particles + scan beam
  function backgroundFx() {
    const c = $('#fx');
    if (!c || reduce) return;
    let pts = [];
    const seed = () => {
      const n = Math.min(80, Math.round((innerWidth * innerHeight) / 18000));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 1.5 + 0.4,
        vx: (Math.random() - 0.5) * 0.15, vy: -(Math.random() * 0.22 + 0.04), a: Math.random() * 0.5 + 0.2,
      }));
    };
    seed();
    addEventListener('resize', seed);
    let beam = -300;
    const loop = t => {
      const { g, w, h } = fit(c);
      g.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.y < -5) { p.y = h + 5; p.x = Math.random() * w; }
        if (p.x < -5) p.x = w + 5; else if (p.x > w + 5) p.x = -5;
      }
      g.lineWidth = 0.6;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d2 = dx * dx + dy * dy;
          if (d2 < 9000) {
            g.strokeStyle = `rgba(${CYAN}, ${0.12 * (1 - d2 / 9000)})`;
            g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[j].x, pts[j].y); g.stroke();
          }
        }
      }
      for (const p of pts) {
        g.fillStyle = `rgba(${CYAN}, ${p.a * (0.6 + 0.4 * Math.sin(t * 0.002 + p.x))})`;
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
      }
      beam += 1.6;
      if (beam > h + 80) beam = -500 - Math.random() * 700;
      if (beam > -80) {
        const grd = g.createLinearGradient(0, beam - 70, 0, beam);
        grd.addColorStop(0, `rgba(${CYAN}, 0)`);
        grd.addColorStop(1, `rgba(${CYAN}, 0.09)`);
        g.fillStyle = grd;
        g.fillRect(0, beam - 70, w, 70);
        g.fillStyle = `rgba(170, 245, 255, 0.28)`;
        g.fillRect(0, beam, w, 1);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ wireframe globe
  function globeFx() {
    const c = $('#globe');
    if (!c) return;
    const rad = Math.PI / 180;
    const tilt = 0.38;
    // A few "uplink" points (lat, lon) that pulse on the globe.
    const nodes = [[40.7, -74], [51.5, -0.1], [35.7, 139.7], [-33.9, 151.2], [37.8, -122.4], [25.2, 55.3], [-23.5, -46.6]];
    let rot = 0;
    const loop = t => {
      const { g, w, h } = fit(c);
      g.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.42, cx = w / 2, cy = h / 2;
      if (!reduce) rot += 0.004;
      const P = (lat, lon) => {
        const la = lat * rad, lo = lon * rad + rot;
        const x = Math.cos(la) * Math.sin(lo), y = Math.sin(la), z = Math.cos(la) * Math.cos(lo);
        const y2 = y * Math.cos(tilt) - z * Math.sin(tilt), z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
        return [cx + x * R, cy - y2 * R, z2];
      };
      const seg = (a, b) => {
        const front = (a[2] + b[2]) / 2 > 0;
        g.strokeStyle = `rgba(${CYAN}, ${front ? 0.55 : 0.1})`;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      };
      g.lineWidth = 0.8;
      for (let lon = 0; lon < 360; lon += 20) {
        let prev = P(-90, lon);
        for (let lat = -84; lat <= 90; lat += 6) { const cur = P(lat, lon); seg(prev, cur); prev = cur; }
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        let prev = P(lat, 0);
        for (let lon = 6; lon <= 360; lon += 6) { const cur = P(lat, lon); seg(prev, cur); prev = cur; }
      }
      g.strokeStyle = `rgba(${CYAN}, 0.35)`;
      g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      for (const [la, lo] of nodes) {
        const p = P(la, lo);
        if (p[2] <= 0) continue;
        const pulse = (Math.sin(t * 0.004 + la) + 1) / 2;
        g.fillStyle = `rgba(255, 179, 71, ${0.6 + 0.4 * pulse})`;
        g.beginPath(); g.arc(p[0], p[1], 1.8 + pulse * 1.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = `rgba(255, 179, 71, ${0.5 * (1 - pulse)})`;
        g.beginPath(); g.arc(p[0], p[1], 3 + pulse * 7, 0, Math.PI * 2); g.stroke();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ radar
  function radarFx() {
    const c = $('#radar');
    if (!c) return;
    let blips = [];
    let last = 0;
    const loop = t => {
      const { g, w, h } = fit(c);
      g.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.44, cx = w / 2, cy = h / 2;
      const ang = reduce ? 0 : (t * 0.0016) % (Math.PI * 2);
      g.strokeStyle = `rgba(${CYAN}, 0.3)`;
      g.lineWidth = 0.8;
      for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(cx, cy, (R * k) / 3, 0, Math.PI * 2); g.stroke(); }
      g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
      // sweep trail
      for (let k = 0; k < 24; k++) {
        const a0 = ang - k * 0.04;
        g.fillStyle = `rgba(${CYAN}, ${0.22 * (1 - k / 24)})`;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0 - 0.04, a0); g.closePath(); g.fill();
      }
      g.strokeStyle = `rgba(190, 248, 255, 0.9)`;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); g.stroke();
      if (t - last > 900) {
        last = t;
        if (blips.length < 6 && Math.random() < 0.7) {
          const a = ang + 0.05, d = R * (0.25 + Math.random() * 0.7);
          blips.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, born: t });
        }
      }
      blips = blips.filter(b => t - b.born < 4000);
      for (const b of blips) {
        const life = 1 - (t - b.born) / 4000;
        g.fillStyle = `rgba(255, 179, 71, ${life})`;
        g.beginPath(); g.arc(b.x, b.y, 2.2, 0, Math.PI * 2); g.fill();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ data stream
  function dataStream() {
    const box = $('#datastream');
    if (!box) return;
    const words = ['SYNC', 'PING', 'AUTH', 'NODE', 'CACHE', 'UPLINK', 'SCAN', 'CORE', 'GRID', 'RELAY'];
    const hex = n => Math.floor(Math.random() * 16 ** n).toString(16).toUpperCase().padStart(n, '0');
    const line = () => `0x${hex(4)}  ${words[Math.floor(Math.random() * words.length)].padEnd(6)} ${hex(2)}:${hex(2)}  ${(90 + Math.random() * 10).toFixed(1)}%`;
    for (let i = 0; i < 8; i++) { const d = document.createElement('div'); d.textContent = line(); box.append(d); }
    if (reduce) return;
    setInterval(() => {
      const d = document.createElement('div');
      d.textContent = line();
      box.append(d);
      while (box.children.length > 8) box.firstChild.remove();
    }, 420);
  }

  // ------------------------------------------------------------ neural orb
  // A 3D sphere of glowing particles joined by faint network lines, with
  // sparks streaking outward. It breathes when idle, swirls fast while
  // thinking, tightens while listening and ripples/bursts with the voice.
  function orbFx() {
    const c = $('#orb');
    if (!c) return;
    const N = matchMedia('(max-width: 760px)').matches ? 900 : 1700;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963; // golden angle spreads points evenly
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * Math.PI * 2, spark: Math.random() < 0.14, sx: 0, sy: 0, d: 0 });
    }
    // Join each point to its nearest neighbours once, up front.
    const edges = [];
    const maxD = 2.9 / Math.sqrt(N);
    for (let i = 0; i < N; i++) {
      let made = 0;
      for (let j = i + 1; j < N && made < 4; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, dz = pts[i].z - pts[j].z;
        if (dx * dx + dy * dy + dz * dz < maxD * maxD * 1.3 && Math.random() < 0.85) { edges.push(i, j); made++; }
      }
    }
    // A loose outer shell of drifting dust for depth.
    const dust = Array.from({ length: Math.round(N / 4) }, () => {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      return { x: Math.cos(a) * s, y: u, z: Math.sin(a) * s, k: 1.15 + Math.random() * 0.6, seed: Math.random() * 6.28 };
    });

    let rotY = 0, rotX = 0.35, lvl = 0, spin = 0.003, tint = 0;
    const bucket = [[], [], []];
    const loop = t => {
      const { g, w, h } = fit(c);
      // Fade the last frame instead of wiping it: moving light leaves swirling trails.
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = `rgba(0, 0, 0, ${reduce ? 1 : 0.32})`;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      const mode = document.body.dataset.mode;
      const target = window.holo?.level || 0;
      lvl += (target - lvl) * (target > lvl ? 0.35 : 0.12);
      const wantSpin = reduce ? 0 : mode === 'thinking' ? 0.02 : 0.0025 + lvl * 0.012;
      spin += (wantSpin - spin) * 0.05;
      rotY += spin;
      rotX = 0.35 + Math.sin(t * 0.0003) * 0.15;
      tint += ((mode === 'thinking' ? 1 : 0) - tint) * 0.05;
      const listening = mode === 'listening';
      const col = listening ? '205, 250, 255' : `${Math.round(95 + 160 * tint)}, ${Math.round(227 - 48 * tint)}, ${Math.round(255 - 184 * tint)}`;

      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) * 0.34 * (1 + lvl * 0.1 - (listening ? 0.05 : 0) + Math.sin(t * 0.0015) * 0.015);
      const cY = Math.cos(rotY), sY = Math.sin(rotY), cX = Math.cos(rotX), sX = Math.sin(rotX);
      const project = (x, y, z, k, out) => {
        const x1 = x * cY - z * sY, z1 = x * sY + z * cY;
        const y1 = y * cX - z1 * sX, z2 = y * sX + z1 * cX;
        const p = 1 + z2 * 0.28;
        out.sx = cx + x1 * R * k * p;
        out.sy = cy + y1 * R * k * p;
        out.d = (z2 + 1) / 2; // 0 = back, 1 = front
      };

      // soft core glow
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
      glow.addColorStop(0, `rgba(${col}, ${0.035 + lvl * 0.07})`);
      glow.addColorStop(0.6, `rgba(${col}, ${0.015 + lvl * 0.025})`);
      glow.addColorStop(1, `rgba(${col}, 0)`);
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);

      g.globalCompositeOperation = 'lighter';
      for (const p of pts) {
        const wave = Math.sin(p.seed + t * 0.0018) * 0.035 + lvl * 0.22 * Math.sin(t * 0.013 + p.y * 7 + p.seed);
        project(p.x, p.y, p.z, 1 + wave, p);
      }

      // network lines, batched by depth so it stays fast
      bucket[0].length = bucket[1].length = bucket[2].length = 0;
      for (let e = 0; e < edges.length; e += 2) {
        const a = pts[edges[e]], b = pts[edges[e + 1]];
        const d = (a.d + b.d) / 2;
        bucket[d < 0.4 ? 0 : d < 0.7 ? 1 : 2].push(a, b);
      }
      g.lineWidth = 0.7;
      const lineA = [0.06, 0.17, 0.36];
      for (let k = 0; k < 3; k++) {
        g.strokeStyle = `rgba(${col}, ${Math.min(0.6, lineA[k] * (1 + lvl * 1.4))})`;
        g.beginPath();
        const list = bucket[k];
        for (let i = 0; i < list.length; i += 2) { g.moveTo(list[i].sx, list[i].sy); g.lineTo(list[i + 1].sx, list[i + 1].sy); }
        g.stroke();
      }

      // sparks shooting outward from the surface
      g.lineWidth = 1;
      for (const p of pts) {
        if (!p.spark || p.d < 0.3) continue;
        const burst = Math.max(0, Math.sin(t * 0.004 + p.seed * 3)) ** 3;
        const len = R * (0.04 + burst * 0.12 + lvl * (0.25 + 0.5 * burst));
        const dx = p.sx - cx, dy = p.sy - cy, m = Math.hypot(dx, dy) || 1;
        g.strokeStyle = `rgba(${col}, ${(0.15 + p.d * 0.5) * (0.4 + lvl)})`;
        g.beginPath();
        g.moveTo(p.sx, p.sy);
        g.lineTo(p.sx + (dx / m) * len, p.sy + (dy / m) * len);
        g.stroke();
      }

      // the particles themselves
      for (const p of pts) {
        const s = 0.6 + p.d * 1.7 + lvl * 0.8;
        g.fillStyle = `rgba(${col}, ${0.18 + p.d * 0.8})`;
        g.fillRect(p.sx - s / 2, p.sy - s / 2, s, s);
      }
      const tmp = { sx: 0, sy: 0, d: 0 };
      for (const q of dust) {
        project(q.x, q.y, q.z, q.k + Math.sin(t * 0.0008 + q.seed) * 0.05 + lvl * 0.3, tmp);
        g.fillStyle = `rgba(${col}, ${0.08 + tmp.d * 0.3})`;
        g.fillRect(tmp.sx, tmp.sy, 1.2, 1.2);
      }
      g.globalCompositeOperation = 'source-over';
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ typewriter replies
  function typeOut(el, onTick) {
    if (!el || reduce) return Promise.resolve();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const texts = nodes.map(n => n.textContent);
    const total = texts.reduce((a, s) => a + s.length, 0);
    if (!total) return Promise.resolve();
    nodes.forEach(n => { n.textContent = ''; });
    el.classList.add('typing');
    const perTick = Math.max(1, Math.ceil(total / 160)); // long answers still finish in ~3s
    let ni = 0, ci = 0;
    return new Promise(resolve => {
      const tick = () => {
        for (let k = 0; k < perTick && ni < nodes.length; k++) {
          ci++;
          nodes[ni].textContent = texts[ni].slice(0, ci);
          if (ci >= texts[ni].length) { ni++; ci = 0; }
        }
        onTick?.();
        if (ni < nodes.length) setTimeout(tick, 16);
        else { el.classList.remove('typing'); resolve(); }
      };
      tick();
    });
  }

  // ------------------------------------------------------------ mouse parallax
  function parallax() {
    if (reduce || matchMedia('(pointer: coarse)').matches) return;
    let tx = 0, ty = 0, x = 0, y = 0;
    addEventListener('mousemove', e => {
      tx = (e.clientX / innerWidth) * 2 - 1;
      ty = (e.clientY / innerHeight) * 2 - 1;
    });
    const loop = () => {
      x += (tx - x) * 0.06;
      y += (ty - y) * 0.06;
      document.body.style.setProperty('--mx', x.toFixed(3));
      document.body.style.setProperty('--my', y.toFixed(3));
      requestAnimationFrame(loop);
    };
    loop();
  }

  orbFx();
  backgroundFx();
  globeFx();
  radarFx();
  dataStream();
  parallax();

  window.holo = { typeOut, userName: '', level: 0 };
  window.holo.bootDone = bootSequence();
})();
