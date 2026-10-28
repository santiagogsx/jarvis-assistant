// Second Brain map: every note, file, topic, tag and folder as a glowing node,
// laid out with a small force simulation (no libraries). Pan, zoom, drag,
// search, filter, and click a node to see it in the inspector.
(() => {
  const $ = s => document.querySelector(s);
  const COLORS = { note: '#5fe3ff', file: '#7aa2ff', website: '#b98cff', topic: '#ffb347', tag: '#ff7ab6', folder: '#7dffb2', task: '#ffd166', person: '#ffffff' };
  const NAMES = { note: 'Notes', file: 'Files', website: 'Websites', topic: 'Topics', tag: 'Tags', folder: 'Folders', task: 'Tasks', person: 'You' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let nodes = [], links = [], byId = new Map(), neighbors = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let hover = null, selected = null, dragging = null, panning = null;
  let alpha = 0, running = false, hidden = new Set(), query = '';
  const forces = { repel: 900, linkLen: 60 };
  let api = null; // set by app.js: { get(path) , ask(text) }

  const canvas = () => $('#brain-canvas');

  async function load() {
    $('#brain-stats').textContent = 'Reading your files…';
    const g = await api.get('/brain/graph').catch(() => ({ nodes: [], links: [] }));
    const R = Math.sqrt(g.nodes.length) * 28 + 80;
    nodes = g.nodes.map(n => ({ ...n, x: (Math.random() - 0.5) * R * 2, y: (Math.random() - 0.5) * R * 2, vx: 0, vy: 0 }));
    byId = new Map(nodes.map(n => [n.id, n]));
    links = g.links.map(l => ({ s: byId.get(l.s), t: byId.get(l.t) })).filter(l => l.s && l.t);
    neighbors = new Map(nodes.map(n => [n.id, new Set()]));
    for (const l of links) { neighbors.get(l.s.id).add(l.t.id); neighbors.get(l.t.id).add(l.s.id); }
    $('#brain-stats').textContent = `${nodes.length} nodes · ${links.length} connections · ${g.files || 0} files read`;
    renderFilters();
    renderHubs();
    fit();
    alpha = 1;
    start();
  }

  function renderFilters() {
    const counts = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
    $('#brain-filters').innerHTML = Object.keys(COLORS).filter(t => counts[t]).map(t =>
      `<label class="bf"><input type="checkbox" data-type="${t}" ${hidden.has(t) ? '' : 'checked'}><i style="background:${COLORS[t]}"></i>${NAMES[t]}<b>${counts[t]}</b></label>`).join('');
    $('#brain-filters').onchange = e => {
      const t = e.target.dataset.type;
      if (!t) return;
      e.target.checked ? hidden.delete(t) : hidden.add(t);
    };
  }

  function renderHubs() {
    const hubs = nodes.filter(n => n.type !== 'person').sort((a, b) => b.degree - a.degree).slice(0, 8);
    $('#brain-hubs').innerHTML = hubs.map(n => `<li data-id="${esc(n.id)}"><i style="background:${COLORS[n.type]}"></i><span>${esc(n.label)}</span><b>${n.degree}</b></li>`).join('') || '<li class="muted">Nothing yet. Ask Jarvis to remember things, or add folders in Settings → Second Brain.</li>';
    $('#brain-hubs').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) select(byId.get(li.dataset.id), true); };
  }

  // ---------------------------------------------------------------- physics
  function tick() {
    const vis = nodes.filter(n => !hidden.has(n.type));
    // Repulsion, only between nodes in nearby grid cells (fast for big brains).
    const cell = 140, grid = new Map();
    for (const n of vis) {
      const key = Math.floor(n.x / cell) + ',' + Math.floor(n.y / cell);
      (grid.get(key) || grid.set(key, []).get(key)).push(n);
    }
    for (const n of vis) {
      const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const m of grid.get((cx + i) + ',' + (cy + j)) || []) {
          if (m === n) continue;
          let dx = n.x - m.x, dy = n.y - m.y, d2 = dx * dx + dy * dy || 0.01;
          if (d2 > cell * cell) continue;
          const f = (forces.repel / d2) * alpha;
          n.vx += dx * f * 0.05; n.vy += dy * f * 0.05;
        }
      }
    }
    for (const l of links) {
      if (hidden.has(l.s.type) || hidden.has(l.t.type)) continue;
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
      const f = ((d - forces.linkLen) / d) * 0.03 * alpha;
      l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    for (const n of vis) {
      if (n === dragging) continue;
      n.vx -= n.x * 0.0015 * alpha; n.vy -= n.y * 0.0015 * alpha; // gentle pull to the middle
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
    }
    alpha = Math.max(0.02, alpha * 0.985);
  }

  // ---------------------------------------------------------------- drawing
  const radius = n => (n.type === 'topic' || n.type === 'folder' ? 3 : 2.2) + Math.sqrt(n.degree || 0) * 1.5;

  function draw(t) {
    const c = canvas();
    if (!c || !$('#brain').classList.contains('open')) { running = false; return; }
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.translate(w / 2 + view.x, h / 2 + view.y);
    g.scale(view.k, view.k);

    const focus = hover || selected;
    const near = focus ? neighbors.get(focus.id) : null;
    const q = query.toLowerCase();
    const matches = n => !q || String(n.label).toLowerCase().includes(q);

    g.lineWidth = 0.6 / view.k;
    for (const l of links) {
      if (hidden.has(l.s.type) || hidden.has(l.t.type)) continue;
      const lit = focus && (l.s === focus || l.t === focus);
      g.strokeStyle = lit ? 'rgba(255,255,255,.55)' : focus ? 'rgba(95,227,255,.04)' : 'rgba(95,227,255,.11)';
      g.beginPath(); g.moveTo(l.s.x, l.s.y); g.lineTo(l.t.x, l.t.y); g.stroke();
    }
    g.globalCompositeOperation = 'lighter';
    for (const n of nodes) {
      if (hidden.has(n.type)) continue;
      const dim = (focus && n !== focus && !near.has(n.id)) || !matches(n);
      const r = radius(n) * (n === focus ? 1.6 : 1);
      g.globalAlpha = dim ? 0.15 : 1;
      g.fillStyle = COLORS[n.type] + '33';
      g.beginPath(); g.arc(n.x, n.y, r * 2.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = COLORS[n.type];
      g.beginPath(); g.arc(n.x, n.y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // Labels: big hubs always, everything when zoomed in, and the focused node + neighbours.
    g.font = `${11 / view.k}px Rajdhani, sans-serif`;
    g.textAlign = 'center';
    for (const n of nodes) {
      if (hidden.has(n.type)) continue;
      const show = n === focus || (near && near.has(n.id)) || (q && matches(n)) || view.k > 1.6 || n.degree >= 8;
      if (!show) continue;
      g.globalAlpha = n === focus ? 1 : 0.75;
      g.fillStyle = '#d9f7ff';
      g.fillText(String(n.label).slice(0, 32), n.x, n.y - radius(n) - 4 / view.k);
    }
    g.globalAlpha = 1;
    if (alpha > 0.02 || dragging) tick();
    else for (const n of nodes) { n.x += Math.sin(t * 0.0006 + n.x) * 0.02; n.y += Math.cos(t * 0.0005 + n.y) * 0.02; }
    requestAnimationFrame(draw);
  }

  function start() { if (!running) { running = true; requestAnimationFrame(draw); } }

  function fit() {
    if (!nodes.length) return;
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const w = canvas().clientWidth || 800, h = canvas().clientHeight || 600;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 200);
    view = { x: 0, y: 0, k: Math.min(2, Math.max(0.3, Math.min(w, h) / span * 0.85)) };
  }

  // ---------------------------------------------------------------- interaction
  const toWorld = (px, py) => {
    const c = canvas(), r = c.getBoundingClientRect();
    return { x: (px - r.left - r.width / 2 - view.x) / view.k, y: (py - r.top - r.height / 2 - view.y) / view.k };
  };
  function nodeAt(px, py) {
    const p = toWorld(px, py);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (hidden.has(n.type)) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < Math.max(radius(n) + 4, 8 / view.k) && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  async function select(n, center) {
    selected = n || null;
    const box = $('#brain-inspector');
    if (!n) { box.innerHTML = '<p class="muted">Click a dot to see what it is and what it connects to.</p>'; return; }
    if (center) { view.x = -n.x * view.k; view.y = -n.y * view.k; }
    box.innerHTML = `<div class="bi-title"><i style="background:${COLORS[n.type]}"></i>${esc(n.label)}</div><div class="muted">${esc(NAMES[n.type] || n.type)} · ${n.degree} connections</div><div class="bi-preview muted">Loading…</div>`;
    const d = await api.get('/brain/node?id=' + encodeURIComponent(n.id)).catch(() => null);
    if (selected !== n) return;
    const prev = d?.preview ? esc(d.preview).slice(0, 600) : d?.related?.length ? 'Mentioned in: ' + d.related.map(esc).join(', ') : '';
    const linked = [...(neighbors.get(n.id) || [])].slice(0, 10).map(id => byId.get(id)).filter(Boolean);
    box.innerHTML = `<div class="bi-title"><i style="background:${COLORS[n.type]}"></i>${esc(n.label)}</div>
      <div class="muted">${esc(NAMES[n.type] || n.type)}${d?.where ? ' · ' + esc(d.where) : ''}</div>
      <div class="bi-preview">${prev || '<span class="muted">No preview.</span>'}</div>
      ${linked.length ? `<div class="bi-links">${linked.map(x => `<button type="button" data-id="${esc(x.id)}"><i style="background:${COLORS[x.type]}"></i>${esc(x.label)}</button>`).join('')}</div>` : ''}
      <button type="button" class="primary bi-ask">Ask Jarvis about this</button>`;
    box.querySelector('.bi-ask').onclick = () => { close(); api.ask(`What do I have in my Second Brain about "${n.label}"? Summarize it for me.`); };
    box.querySelectorAll('.bi-links button').forEach(b => { b.onclick = () => select(byId.get(b.dataset.id), true); });
  }

  function bind() {
    const c = canvas();
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      const k2 = Math.min(6, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      view.x = mx - (mx - view.x) * (k2 / view.k);
      view.y = my - (my - view.y) * (k2 / view.k);
      view.k = k2;
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const n = nodeAt(e.clientX, e.clientY);
      if (n) { dragging = n; alpha = Math.max(alpha, 0.3); } else panning = { x: e.clientX - view.x, y: e.clientY - view.y, moved: false };
    });
    c.addEventListener('pointermove', e => {
      if (dragging) { const p = toWorld(e.clientX, e.clientY); dragging.x = p.x; dragging.y = p.y; dragging.vx = dragging.vy = 0; dragging.moved = true; return; }
      if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; panning.moved = true; return; }
      hover = nodeAt(e.clientX, e.clientY);
      c.style.cursor = hover ? 'pointer' : 'grab';
    });
    c.addEventListener('pointerup', e => {
      if (dragging) { if (!dragging.moved) select(dragging); dragging.moved = false; dragging = null; }
      else if (panning && !panning.moved) select(nodeAt(e.clientX, e.clientY));
      panning = null;
    });
    c.addEventListener('pointerleave', () => { hover = null; });
    $('#brain-search').addEventListener('input', e => { query = e.target.value.trim(); });
    $('#brain-search').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const n = nodes.filter(x => String(x.label).toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.degree - a.degree)[0];
      if (n) select(n, true);
    });
    $('#brain-repel').oninput = e => { forces.repel = Number(e.target.value); alpha = 0.6; };
    $('#brain-link').oninput = e => { forces.linkLen = Number(e.target.value); alpha = 0.6; };
    $('#brain-fit').onclick = fit;
    $('#brain-refresh').onclick = async () => { await api.post('/brain/rebuild'); load(); };
    $('#brain-close').onclick = close;
  }

  function open() {
    $('#brain').classList.add('open');
    document.body.classList.add('brain-open');
    select(null);
    load();
  }
  function close() {
    $('#brain').classList.remove('open');
    document.body.classList.remove('brain-open');
  }

  window.brainMap = {
    init(a) { api = a; bind(); },
    open, close,
    get isOpen() { return $('#brain').classList.contains('open'); },
    refresh() { if (this.isOpen) load(); },
  };
})();
