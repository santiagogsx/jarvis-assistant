// Extra-monitor display: live data plus Jarvis's state (listening/thinking/
// speaking), which the main window sends through the desktop app.
(() => {
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const view = params.get('view') === 'intel' ? 'intel' : 'systems';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const get = path => fetch('/api' + path).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))));

  $('#view-' + view).hidden = false;
  get('/settings').then(s => {
    const n = (s.assistantName || 'Jarvis').trim();
    $('.sat-head .name').textContent = /^[a-z]{2,8}$/i.test(n) ? n.toUpperCase().split('').join('.') + '.' : n.toUpperCase();
  }).catch(() => {});
  $('#sat-label').textContent = `DISPLAY ${params.get('n') || 2} · ${view.toUpperCase()}`;
  setTimeout(() => document.body.classList.add('booted'), 150);

  function tick() {
    const d = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    for (const [c, dt] of [['#clock', '#date'], ['#clock2', '#date2']]) {
      if ($(c)) $(c).textContent = time;
      if ($(dt)) $(dt).textContent = date;
    }
  }
  tick();
  setInterval(tick, 1000);

  async function stats() {
    if (!$('#cpu-bar')) return;
    try {
      const s = await get('/stats');
      $('#cpu-bar').style.width = s.cpu + '%';
      $('#cpu-val').textContent = s.cpu + '%';
      $('#mem-bar').style.width = s.mem + '%';
      $('#mem-val').textContent = s.mem + '%';
      $('#host').textContent = s.host;
      const h = Math.floor(s.uptime / 3600), m = Math.floor((s.uptime % 3600) / 60);
      $('#uptime').textContent = `${h}h ${m}m`;
    } catch {}
  }

  async function weather() {
    if (!$('#weather')) return;
    try {
      const w = await get('/weather');
      if (w.error) return;
      $('#weather').className = '';
      $('#weather').innerHTML = `<div class="wx-now"><div><div class="wx-temp">${w.temp}${esc(w.unit)}</div><div class="muted">${esc(w.now.conditions)} · ${esc(w.place)}</div></div></div>
        <div class="wx-days">${w.forecast.map(f => `<div>${new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' })}<b>${esc(f.high)}</b>${esc(f.low)}</div>`).join('')}</div>`;
    } catch {}
  }

  async function news() {
    if (!$('#news')) return;
    try {
      const n = await get('/news');
      $('#news').innerHTML = n.headlines.slice(0, 8).map((h, i) => {
        const [title, source] = h.headline.split(/ - (?=[^-]+$)/);
        return `<li style="animation-delay:${i * 0.08}s">${esc(title)}<small>${esc(source || h.source || '')}</small></li>`;
      }).join('') || '<li class="muted">No headlines.</li>';
    } catch {}
  }

  async function reminders() {
    if (!$('#reminders')) return;
    try {
      const [rem, tasks] = await Promise.all([get('/reminders'), get('/tasks').catch(() => [])]);
      const items = [
        ...rem.sort((a, b) => a.due - b.due).map(r => `<li><time>${new Date(r.due).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</time>${esc(r.message)}</li>`),
        ...tasks.filter(t => !t.done).slice(0, 6).map(t => `<li><time>TASK${t.due ? ' · ' + esc(t.due) : ''}</time>${esc(t.text)}</li>`),
      ];
      $('#reminders').innerHTML = items.join('') || '<li class="muted">Nothing scheduled.</li>';
    } catch {}
  }

  stats(); setInterval(stats, 3000);
  weather(); setInterval(weather, 30 * 60 * 1000);
  news(); setInterval(news, 15 * 60 * 1000);
  reminders(); setInterval(reminders, 30 * 1000);

  // Follow Jarvis's mood from the main window; fake a voice rhythm while he speaks.
  const status = { idle: 'ONLINE', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING', error: 'ALERT' };
  window.jarvisDesktop?.onMode(mode => {
    document.body.dataset.mode = mode;
    if ($('#status-text')) $('#status-text').textContent = status[mode] || 'ONLINE';
  });
  const pulse = t => {
    const mode = document.body.dataset.mode;
    if (window.holo) {
      window.holo.level = mode === 'speaking' ? 0.25 + 0.35 * Math.abs(Math.sin(t * 0.011) * Math.sin(t * 0.0047 + 1))
        : mode === 'listening' ? 0.12 : 0;
    }
    requestAnimationFrame(pulse);
  };
  requestAnimationFrame(pulse);
})();
