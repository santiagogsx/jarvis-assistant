// J.A.R.V.I.S. front end. Runs the same in the desktop hologram window,
// any desktop browser, and phones.
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const desk = window.jarvisDesktop || null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  const isTouch = matchMedia('(pointer: coarse)').matches;

  const state = {
    settings: null, local: false, history: [], busy: false, listening: false,
    pass: lsGet('jarvis-pass', ''), muted: lsGet('jarvis-mute') === '1', micOff: lsGet('jarvis-mic-off') === '1',
    rec: null, recorder: null, formModels: {},
  };

  const log = $('#log');
  const input = $('#input');
  const micBtn = $('#mic-btn');
  const title = () => state.settings?.userTitle || 'sir';
  const aiName = () => (state.settings?.assistantName || 'Jarvis').trim() || 'Jarvis';
  // "Jarvis" -> "J.A.R.V.I.S.", "Friday" -> "F.R.I.D.A.Y.", longer names stay plain.
  const brand = name => (/^[a-z]{2,8}$/i.test(name) ? name.toUpperCase().split('').join('.') + '.' : name.toUpperCase());

  function applyName() {
    const b = brand(aiName());
    $('.brand .name').textContent = b;
    $('.lock-title').textContent = b;
    const bootTitle = $('.boot-title');
    if (bootTitle) bootTitle.textContent = b;
    document.title = b;
    if (window.holo) window.holo.brand = b;
  }

  // ---------------------------------------------------------------- API
  async function api(path, { method = 'GET', body, raw, type } = {}) {
    const headers = {};
    if (state.pass) headers['x-jarvis-pass'] = state.pass;
    let payload;
    if (raw) { payload = raw; headers['content-type'] = type || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch('/api' + path, { method, headers, body: payload }); }
    catch { throw new Error("I can't reach the main computer. Is Jarvis running there?"); }
    if (res.status === 401) { await askPasscode('Enter the passcode to continue.'); return api(path, { method, body, raw, type }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------- passcode lock
  let lockWaiters = [];
  function askPasscode(msg) {
    $('#lock-msg').textContent = msg;
    $('#lock').hidden = false;
    setTimeout(() => $('#lock-input').focus(), 50);
    return new Promise(resolve => lockWaiters.push(resolve));
  }
  $('#lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#lock-input').value.trim();
    if (!pass) return;
    const hello = await fetch('/api/hello', { headers: { 'x-jarvis-pass': pass } }).then(r => r.json()).catch(() => null);
    if (hello?.status === 'ok') {
      state.pass = pass;
      lsSet('jarvis-pass', pass);
      $('#lock').hidden = true;
      $('#lock-input').value = '';
      lockWaiters.forEach(r => r());
      lockWaiters = [];
    } else {
      $('#lock-msg').textContent = hello?.status === 'locked' ? 'Too many wrong tries. Wait 10 minutes.' : 'Wrong passcode. Try again.';
      $('#lock-input').select();
    }
  });

  // ---------------------------------------------------------------- conversation
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function render(text) {
    let h = esc(text);
    h = h.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    h = h.replace(/(^|\n)((?:\s*(?:[-•*]|\d+\.) .+(?:\n|$))+)/g, (_, pre, block) =>
      pre + '<ul>' + block.trim().split('\n').map(l => `<li>${l.trim().replace(/^([-•*]|\d+\.) /, '')}</li>`).join('') + '</ul>');
    return h.replace(/\n/g, '<br>');
  }

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'tool') {
      div.textContent = text;
    } else {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = role === 'user' ? (state.settings?.userName || 'You').toUpperCase() : role === 'jarvis' ? brand(aiName()) : 'SYSTEM';
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = render(text);
      div.append(who, body);
    }
    log.append(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  const sys = text => addMsg('system', text);

  const TOOL_LABELS = {
    get_weather: 'Checking the weather', web_search: 'Searching the web', read_webpage: 'Reading a page',
    get_news: 'Pulling headlines', check_email: 'Checking email', search_email: 'Searching email', read_email: 'Reading email',
    draft_email: 'Drafting email', music: 'Music control', find_products: 'Comparing products', prepare_order: 'Preparing order',
    set_reminder: 'Setting reminder', save_note: 'Saving note', get_notes: 'Reading notes', draft_social_post: 'Drafting post',
    open_website: 'Opening link', open_social: 'Opening social', open_app: 'Opening app', text_me: 'Sending text', call_me: 'Placing call',
    system_status: 'Running diagnostics', get_datetime: 'Checking the time',
    add_task: 'Updating your list', list_tasks: 'Checking your list', complete_task: 'Ticking it off',
    browser_search: 'Live browser', browser_open: 'Live browser', browser_click: 'Live browser', browser_type: 'Live browser',
    browser_scroll: 'Live browser', browser_back: 'Live browser', browser_read: 'Live browser', browser_close: 'Closing browser',
    build_website: 'Building website', read_website_file: 'Reading website', list_websites: 'Checking websites',
    trading_account: 'Checking your account', market_quote: 'Getting the price', prepare_trade: 'Preparing order ticket',
    make_folder: 'Making folder', download_file: 'Downloading file', move_file: 'Moving file', copy_file: 'Copying file',
    list_folder: 'Looking in folder', open_folder: 'Opening folder',
    schedule_routine: 'Scheduling routine', list_routines: 'Checking routines', create_file: 'Writing file', list_files: 'Checking files',
  };

  function openUrl(url) {
    if (desk) return desk.openExternal(url);
    if (!isTouch) { const w = window.open(url, '_blank'); if (w) w.opener = null; }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  function emailDraft(d) {
    const box = document.createElement('div');
    box.className = 'draft';
    box.innerHTML = `
      <input class="d-to" aria-label="To" placeholder="To">
      <input class="d-cc" aria-label="Cc" placeholder="Cc (optional)">
      <input class="d-subject" aria-label="Subject" placeholder="Subject">
      <textarea class="d-body" aria-label="Message"></textarea>
      <div class="row"><button type="button" class="d-discard">Discard</button><button type="button" class="send-mail primary">Send email</button></div>`;
    box.querySelector('.d-to').value = d.to || '';
    box.querySelector('.d-cc').value = d.cc || '';
    box.querySelector('.d-subject').value = d.subject || '';
    box.querySelector('.d-body').value = d.body || '';
    box.querySelector('.d-discard').onclick = () => { box.innerHTML = '<span class="muted">Draft discarded.</span>'; };
    box.querySelector('.send-mail').onclick = async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const r = await api('/email/send', { method: 'POST', body: {
          to: box.querySelector('.d-to').value, cc: box.querySelector('.d-cc').value,
          subject: box.querySelector('.d-subject').value, body: box.querySelector('.d-body').value, inReplyTo: d.inReplyTo,
        } });
        if (r.error) throw new Error(r.error);
        box.innerHTML = '<span style="color:#7dffb2">✓ Email sent.</span>';
        speak(`Sent, ${title()}.`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Send email';
        sys('Email not sent: ' + err.message);
      }
    };
    return box;
  }

  // Order ticket: nothing reaches the broker until this Confirm button is tapped.
  function tradeTicket(t) {
    const box = document.createElement('div');
    box.className = 'ticket';
    const money = v => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 }));
    const rows = [
      ['Broker', t.broker_name], ['Symbol', t.symbol], ['Side', t.side.toUpperCase()], ['Type', t.type],
      [t.quantity ? 'Quantity' : 'Amount', t.quantity ? money(t.quantity) : '$' + money(t.amount_usd)],
      ['Limit price', t.limit_price ? money(t.limit_price) : null], ['Stop-loss', t.stop_loss ? money(t.stop_loss) : null],
      ['Take-profit', t.take_profit ? money(t.take_profit) : null], ['Price now (approx.)', t.est_price ? money(t.est_price) : null],
      ['Estimated total', t.est_total ? '$' + money(t.est_total) : null],
    ].filter(r => r[1] != null);
    box.innerHTML = `<div class="mode ${t.live ? 'live' : 'paper'}">${t.live ? '⚠ LIVE: REAL MONEY' : 'PRACTICE ACCOUNT'}</div>
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="confirm">Confirm order</button></div>`;
    box.querySelector('.cancel').onclick = () => { box.innerHTML = '<span class="muted">Order cancelled. Nothing was sent.</span>'; };
    box.querySelector('.confirm').onclick = async e => {
      if (!state.local) return sys('Orders can only be confirmed on the main computer.');
      if (t.live && !confirm(`Send this LIVE order with real money?\n\n${t.side.toUpperCase()} ${t.quantity || '$' + t.amount_usd} ${t.symbol}`)) return;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Sending…';
      const r = await api('/trade/confirm', { method: 'POST', body: { id: t.id } }).catch(err => ({ error: err.message }));
      if (r.error) { box.innerHTML = `<span style="color:#ffb4aa">Order not sent: ${esc(r.error)}</span>`; return; }
      box.innerHTML = `<span style="color:#7dffb2">✓ Order sent to ${esc(r.broker)}${r.status ? ' (' + esc(r.status) + ')' : ''}.</span>`;
      speak(`Order sent, ${title()}.`);
    };
    return box;
  }

  function handleActions(actions, el) {
    if (!actions?.length || !el) return;
    let chips = null;
    for (const a of actions) {
      if (a.type === 'copy') copyText(a.text);
      else if (a.type === 'open') {
        if (!chips) { chips = document.createElement('div'); chips.className = 'chips'; (el.querySelector('.body') || el).append(chips); }
        const link = document.createElement('a');
        link.className = 'chip';
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '↗ ' + (a.label || 'Open');
        chips.append(link);
        openUrl(a.url);
      } else if (a.type === 'email') {
        (el.querySelector('.body') || el).append(emailDraft(a.draft));
      } else if (a.type === 'trade') {
        (el.querySelector('.body') || el).append(tradeTicket(a.ticket));
      }
    }
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    unlockAudio();
    stopSpeaking();
    addMsg('user', text);
    state.history.push({ role: 'user', content: text });
    state.busy = true;
    setMode('thinking');

    // Stream the answer: words appear as the AI writes them, and each finished
    // sentence is spoken right away instead of waiting for the whole reply.
    let el = null, shown = '', pending = '', spoken = 0, capped = false, drawQueued = false;
    const started = performance.now();
    const body = () => el.querySelector('.body');
    const draw = () => {
      drawQueued = false;
      body().innerHTML = render(shown);
      body().classList.add('typing');
      log.scrollTop = log.scrollHeight;
    };
    const speakReady = (final = false) => {
      if (state.muted || capped) return;
      // Take everything up to the last sentence end (or all of it at the end).
      const m = final ? pending : (pending.match(/^[\s\S]*[.!?:](?=\s)/) || [''])[0];
      if (!m.trim() || (!final && m.length < 24)) return;
      pending = pending.slice(m.length);
      if (/```/.test(m)) return; // don't read code aloud
      // Speak sentence by sentence, about 450 characters at most; the rest stays on screen.
      for (const sentence of m.match(/[^.!?:]+[.!?:]*\s*/g) || [m]) {
        const say = cleanSpeech(sentence);
        if (!say) continue;
        if (spoken > 0 && spoken + say.length > 450) { capped = true; queueSpeech('The details are on screen.'); return; }
        spoken += say.length;
        queueSpeech(say);
      }
    };
    let r;
    try {
      r = await askStream({ history: state.history.slice(-24), deviceCity: deviceCity(), stream: true }, tok => {
        if (!el) { el = addMsg('jarvis', ''); }
        shown += tok;
        pending += tok;
        if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); }
        speakReady();
      });
    } catch (e) { r = { error: e.message }; }
    state.busy = false;
    if (r.error) {
      state.history.pop();
      el?.remove();
      handleActions(r.actions, sys(r.error));
      setMode('error');
      setTimeout(() => { if (document.body.dataset.mode === 'error') setMode('idle'); }, 2500);
      return;
    }
    state.history.push({ role: 'assistant', content: r.reply });
    if (state.history.length > 60) state.history = state.history.slice(-40);
    if (!el) {
      // Nothing streamed (e.g. the free starter AI): show it with the typing effect.
      el = addMsg('jarvis', r.reply);
      window.holo?.typeOut(body(), () => { log.scrollTop = log.scrollHeight; });
      pending = r.reply;
    } else {
      // Use the final text (it can include a note added after streaming).
      if (r.reply.startsWith(shown.trim())) pending += r.reply.slice(shown.trim().length);
      shown = r.reply;
      draw();
      body().classList.remove('typing');
    }
    handleActions(r.actions, el);
    speakReady(true);
    // A slow answer on the starter AI: point to the free fix (once per session).
    if (state.local && !state.fastTipShown && state.settings?.provider === 'free' && !hasFastAI() && performance.now() - started > 8000) {
      state.fastTipShown = true;
      fastTip('That took a while because I\'m on the slow free starter AI. A free Groq key makes me answer in about a second.');
    }
    if (!speechBusy() && document.body.dataset.mode === 'thinking') setMode('idle');
  }

  // POST /api/ask as a stream of JSON lines: {t:'token'} … then {t:'done'} or {t:'error'}.
  async function askStream(payload, onToken) {
    const headers = { 'content-type': 'application/json' };
    if (state.pass) headers['x-jarvis-pass'] = state.pass;
    let res;
    try { res = await fetch('/api/ask', { method: 'POST', headers, body: JSON.stringify(payload) }); }
    catch { throw new Error("I can't reach the main computer. Is Jarvis running there?"); }
    if (res.status === 401) { await askPasscode('Enter the passcode to continue.'); return askStream(payload, onToken); }
    if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'token') onToken(m.v);
        else if (m.t === 'done') result = { reply: m.reply, actions: m.actions };
        else if (m.t === 'error') result = { error: m.error, actions: m.actions };
      }
    }
    return result || { error: 'The answer was cut off. Please try again.' };
  }

  function setMode(mode) {
    document.body.dataset.mode = mode;
    desk?.sendMode?.(mode); // the extra monitors react too
    // Only listen for the wake word while Jarvis is idle (so he can't wake himself up).
    if (window.wake?.running) { if (mode === 'idle' || mode === 'error') window.wake.resume(); else window.wake.pause(); }
    if (mode === 'idle') caption('');
    else if (mode === 'listening') caption('Listening…');
    else if (mode === 'thinking') caption('One moment…');
    $('#status-text').textContent = { idle: 'ONLINE', listening: 'LISTENING', thinking: 'PROCESSING', speaking: 'SPEAKING', error: 'ALERT' }[mode] || 'ONLINE';
  }

  // ---------------------------------------------------------------- voice out
  let actx = null;
  let audioSrc = null;
  const viz = { analyser: null, data: null, energy: 0 };

  function unlockAudio() {
    try {
      if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)(); applySpeaker(); }
      if (actx.state === 'suspended') actx.resume();
    } catch {}
    // iOS only lets a page talk after one speech call made from a tap.
    if (!state.voiceUnlocked && 'speechSynthesis' in window) {
      state.voiceUnlocked = true;
      try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch {}
    }
  }

  // ---- chosen microphone / speaker (saved per device)
  const micId = () => lsGet('jarvis-mic', '');
  function applySpeaker() {
    const id = lsGet('jarvis-speaker', '');
    if (actx?.setSinkId) actx.setSinkId(id || '').catch(() => actx.setSinkId('').catch(() => {}));
  }

  async function fillAudioDevices() {
    const micSel = F('micId'), spkSel = F('speakerId');
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
    // Device names are hidden until the page has had microphone access once.
    if (list.length && !list.some(d => d.label) && !state.micOff) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); list = await navigator.mediaDevices.enumerateDevices(); } catch {}
    }
    const opts = kind => '<option value="">System default</option>' + list
      .filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`)}</option>`).join('');
    micSel.innerHTML = opts('audioinput');
    spkSel.innerHTML = opts('audiooutput');
    micSel.value = micId();
    spkSel.value = lsGet('jarvis-speaker', '');
    if (micSel.value !== micId()) micSel.value = '';
    if (!spkSel.value) spkSel.value = '';
    // iPhones/Safari can't pick a speaker from a web page.
    spkSel.disabled = !(window.AudioContext && 'setSinkId' in AudioContext.prototype);
  }

  // Light "AI in the room" treatment for the premium voices: cleaner lows, a
  // touch of presence and a small, short reverb.
  function voiceChain(input) {
    if (lsGet('jarvis-voicefx', '1') !== '1') return input;
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 110;
    const presence = actx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3200;
    presence.gain.value = 3;
    presence.Q.value = 0.9;
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    if (!voiceChain.ir) {
      const len = Math.round(actx.sampleRate * 0.45);
      const ir = actx.createBuffer(2, len, actx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      voiceChain.ir = ir;
    }
    const verb = actx.createConvolver();
    verb.buffer = voiceChain.ir;
    const wet = actx.createGain();
    wet.gain.value = 0.16;
    const out = actx.createGain();
    input.connect(hp).connect(presence).connect(comp);
    comp.connect(out);
    comp.connect(verb).connect(wet).connect(out);
    return out;
  }

  // Text made ready to read aloud (no links, symbols or code; names said right).
  function cleanSpeech(text) {
    let t = String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`#>•]/g, '')
      .replace(/J\.A\.R\.V\.I\.S\./g, 'Jarvis')
      .split(brand(aiName())).join(aiName());
    const nm = state.settings?.userName, say = state.settings?.namePronounce;
    if (nm && say) t = t.replace(new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), say);
    return t.replace(/\s+/g, ' ').trim();
  }

  // ---- speech queue: sentences play back-to-back; the next one's audio is
  // made while the current one plays, so there are no pauses.
  const sq = { items: [], running: false, gen: 0 };
  const speechBusy = () => sq.running || sq.items.length > 0;
  function queueSpeech(text) {
    if (state.muted || !text) return;
    const engine = state.settings?.voice?.engine || 'system';
    const item = { text, audio: null };
    if (engine !== 'system') {
      item.audio = api('/tts', { method: 'POST', body: { text } }).then(async r => {
        if (!r.audio) throw new Error(r.error || 'no audio');
        unlockAudio();
        const bytes = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0));
        return actx.decodeAudioData(bytes.buffer);
      });
      item.audio.catch(() => {});
    }
    sq.items.push(item);
    if (!sq.running) runSpeech(sq.gen);
  }
  async function runSpeech(gen) {
    sq.running = true;
    setMode('speaking');
    while (sq.items.length && gen === sq.gen) {
      const item = sq.items.shift();
      try {
        if (item.audio) await playBuffer(await item.audio, item.text);
        else await speakSystem(item.text);
      } catch (e) {
        if (!state.warnedVoice) { state.warnedVoice = true; sys(`Premium voice unavailable (${e.message}). Using the built-in voice.`); }
        if (gen === sq.gen) await speakSystem(item.text);
      }
    }
    if (gen === sq.gen) {
      sq.running = false;
      if (document.body.dataset.mode === 'speaking') setMode(state.busy ? 'thinking' : 'idle');
    }
  }

  function speechText(text) {
    let t = String(text)
      .replace(/```[\s\S]*?```/g, ' (code on screen) ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`#>•]/g, '')
      .replace(/J\.A\.R\.V\.I\.S\./g, 'Jarvis')
      .split(brand(aiName())).join(aiName());
    const nm = state.settings?.userName, say = state.settings?.namePronounce;
    if (nm && say) t = t.replace(new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), say);
    if (t.length > 450) {
      const first = t.split(/\n\s*\n/)[0];
      const short = first.length > 450 ? (first.match(/^(.{40,420}?[.!?])\s/s)?.[1] || first.slice(0, 420)) : first;
      t = short + ' The details are on screen.';
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function stopSpeaking() {
    sq.gen++;
    sq.items = [];
    sq.running = false;
    try { speechSynthesis.cancel(); } catch {}
    if (audioSrc) { try { audioSrc.onended = null; audioSrc.stop(); } catch {} audioSrc = null; }
    viz.analyser = null;
    if (document.body.dataset.mode === 'speaking') setMode('idle');
  }

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    const want = state.settings?.voice?.systemVoice;
    if (want) { const v = voices.find(x => x.name === want); if (v) return v; }
    const prefs = ['Microsoft Ryan Online', 'Microsoft Thomas Online', 'Microsoft George', 'Google UK English Male', 'Daniel', 'Arthur', 'Oliver', 'Malcolm'];
    for (const p of prefs) { const v = voices.find(x => x.name.includes(p)); if (v) return v; }
    return voices.find(v => v.lang === 'en-GB') || voices.find(v => v.lang?.startsWith('en')) || null;
  }

  function speakSystem(text) {
    return new Promise(resolve => {
      if (!('speechSynthesis' in window)) return resolve();
      const v = state.settings?.voice || {};
      const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
      const chunks = [];
      let cur = '';
      for (const p of parts) { if ((cur + p).length > 220 && cur) { chunks.push(cur); cur = ''; } cur += p; }
      if (cur.trim()) chunks.push(cur);
      const voice = pickVoice();
      chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c);
        if (voice) u.voice = voice;
        u.rate = Number(v.rate) || 1;
        u.pitch = Number(v.pitch) || 0.9;
        u.onboundary = () => { viz.energy = 1; };
        u.onstart = () => caption(c.trim());
        if (i === chunks.length - 1) { u.onend = resolve; u.onerror = resolve; }
        speechSynthesis.speak(u);
      });
      if (!chunks.length) resolve();
    });
  }

  async function speakPremium(text, preview) {
    const r = await api('/tts', { method: 'POST', body: { text, preview } });
    if (!r.audio) throw new Error(r.error || 'no audio');
    unlockAudio();
    const bytes = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0));
    return playBuffer(await actx.decodeAudioData(bytes.buffer), text);
  }

  // Play decoded speech through the voice effect + orb analyser, with subtitles.
  function playBuffer(buffer, text) {
    return new Promise(resolve => {
      const src = actx.createBufferSource();
      src.buffer = buffer;
      const an = actx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.7;
      voiceChain(src).connect(an);
      an.connect(actx.destination);
      viz.analyser = an;
      viz.data = new Uint8Array(an.frequencyBinCount);
      src.onended = () => { viz.analyser = null; resolve(); };
      audioSrc = src;
      caption(text.length > 170 ? text.slice(0, 170).replace(/\s\S*$/, '') + '…' : text);
      src.start();
    });
  }

  async function speak(text, preview) {
    if (state.muted || !text) return;
    const clean = speechText(text);
    if (!clean) return;
    setMode('speaking');
    const engine = preview?.engine || state.settings?.voice?.engine || 'system';
    try {
      if (engine !== 'system') await speakPremium(clean, preview);
      else await speakSystem(clean);
    } catch (e) {
      if (engine !== 'system') {
        if (!state.warnedVoice) { state.warnedVoice = true; sys(`Premium voice unavailable (${e.message}). Using the built-in voice.`); }
        await speakSystem(clean);
      }
    }
    if (document.body.dataset.mode === 'speaking') setMode('idle');
  }

  // ---------------------------------------------------------------- hologram visualizer
  // Works out how "loud" Jarvis (or your mic) is right now; the orb in fx.js
  // reads window.holo.level to pulse and throw sparks.
  function frame(t) {
    const mode = document.body.dataset.mode;
    let level = 0;
    if (viz.analyser) {
      viz.analyser.getByteFrequencyData(viz.data);
      let s = 0;
      const n = Math.floor(viz.data.length * 0.6);
      for (let i = 0; i < n; i++) s += viz.data[i];
      level = Math.min(1, (s / n / 255) * 2.2);
    } else if (mode === 'speaking') {
      // The built-in voice gives no audio data, so fake a speech rhythm; word boundaries add punch.
      viz.energy *= 0.9;
      level = Math.max(viz.energy * 0.9, 0.25 + 0.35 * Math.abs(Math.sin(t * 0.011) * Math.sin(t * 0.0047 + 1)));
    } else if (mode === 'listening') {
      level = 0.12 + 0.06 * Math.sin(t * 0.006);
    }
    if (window.holo) window.holo.level = level;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Subtitles inside the orb, like a film HUD.
  function caption(text) {
    const el = $('#caption');
    const idle = `How may I help, ${state.settings?.userName || title()}?`;
    el.textContent = text || idle;
    el.classList.toggle('idle', !text);
  }

  // ---------------------------------------------------------------- voice in
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const useBrowserSR = !!SR && !desk; // Electron has the API but it doesn't work there

  function setListening(on) {
    state.listening = on;
    micBtn.classList.toggle('on', on);
    if (on) setMode('listening');
  }

  async function toggleListen(fromWake = false) {
    if (state.listening) return stopListening();
    if (state.busy) return;
    // "Only when I say his name": the mic button/hotkey don't open the mic (unless the wake word can't run here).
    if (!fromWake && listenMode() === 'name' && window.wake?.running) {
      return sys(`I'm set to listen only when you say my name. Say "Hey ${aiName()}", or change it in Settings → This device.`);
    }
    if (state.micOff) return sys(`The microphone is off, so ${aiName()} can't hear you. Tap the crossed-out mic at the top to turn it back on, or type instead.`);
    unlockAudio();
    stopSpeaking();
    if (useBrowserSR) return browserListen();
    if (!navigator.mediaDevices?.getUserMedia) {
      return sys(window.isSecureContext ? "This browser can't use the microphone. Type instead." : 'Phones only allow the microphone on a secure https link. Open Jarvis through your https link (see README: "Use Jarvis from anywhere"), or type instead.');
    }
    let ready;
    try { ready = await api('/stt-ready'); } catch (e) { return sys(e.message); }
    if (!ready.ok) {
      // No speech-to-text key: use the free offline engine instead.
      if (window.wake?.supported) return voskListen();
      return sys(ready.message);
    }
    recordAndTranscribe();
  }

  async function voskListen() {
    setListening(true);
    state.voskActive = true;
    let text = '';
    try {
      // Other languages/accents use their own offline model (downloaded once by the server).
      let modelUrl = null;
      if (!/^(auto|en|en-us|en-gb|en-au)$/.test(state.settings?.sttLanguage || 'auto')) {
        caption('Loading speech model…');
        modelUrl = (await api('/stt-model').catch(() => ({}))).url || null;
        caption('Listening…');
      }
      text = await window.wake.listenOnce(p => { input.value = p; caption(`“${p}”`); }, 15000, modelUrl);
    } catch (e) {
      sys('Voice input could not start: ' + e.message);
    }
    state.voskActive = false;
    setListening(false);
    input.value = '';
    if (text) ask(text); else setMode('idle');
  }

  // Short two-tone chime, like a smart speaker waking up.
  function chime() {
    unlockAudio();
    if (!actx) return;
    const t = actx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      const at = t + i * 0.09;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(g).connect(actx.destination);
      o.start(at);
      o.stop(at + 0.2);
    });
  }

  function onWakeWord() {
    if (state.busy || state.listening || document.body.dataset.mode !== 'idle') return;
    chime();
    setTimeout(() => toggleListen(true), 180);
  }

  // Mic off = the microphone is released completely: no wake word, no listening.
  function applyMicSwitch() {
    const b = $('#micoff-btn');
    b.classList.toggle('off', state.micOff);
    b.setAttribute('aria-pressed', String(state.micOff));
    b.title = state.micOff ? 'Microphone is OFF: tap to turn it on' : 'Turn microphone off';
    b.setAttribute('aria-label', b.title);
    micBtn.classList.toggle('disabled', state.micOff);
    micBtn.title = state.micOff ? 'Microphone is off' : 'Talk (Ctrl+Shift+J)';
  }

  async function setMicOff(off) {
    state.micOff = off;
    lsSet('jarvis-mic-off', off ? '1' : '0');
    applyMicSwitch();
    if (off) {
      if (state.listening) stopListening();
      $('#wake-badge').hidden = true;
      await window.wake?.release();
      sys(`Microphone off. ${aiName()} can't hear anything until you turn it back on.`);
    } else {
      sys('Microphone on.');
      if (wakeWanted()) setWake(true);
    }
  }
  $('#micoff-btn').onclick = () => setMicOff(!state.micOff);

  async function setWake(on) {
    const badge = $('#wake-badge');
    if (on && state.micOff) return;
    if (micId()) await window.wake?.setMic(micId()).catch(() => {});
    if (!window.wake?.supported) { badge.hidden = true; return; }
    if (!on) { window.wake.stop(); badge.hidden = true; return; }
    badge.hidden = false;
    badge.classList.add('loading');
    badge.textContent = `● HEY ${aiName().toUpperCase()}`;
    try {
      await window.wake.start(onWakeWord, aiName());
      badge.classList.remove('loading');
    } catch (e) {
      badge.hidden = true;
      sys('Wake word could not start: ' + (e.message || e));
    }
  }

  function browserListen() {
    const rec = new SR();
    // Phone speech recognition: use the chosen language/accent (e.g. en-IN, es-ES) or the phone's own.
    const want = state.settings?.sttLanguage || 'auto';
    const LOCALES = { en: 'en-US', 'en-us': 'en-US', 'en-gb': 'en-GB', 'en-in': 'en-IN', 'en-au': 'en-AU', es: 'es-ES', 'es-mx': 'es-MX', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT', hi: 'hi-IN' };
    rec.lang = want === 'auto' ? (navigator.language || 'en-US') : (LOCALES[want] || navigator.language || 'en-US');
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = e => {
      let interim = '';
      for (const r of e.results) { if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
      input.value = finalText || interim;
      caption(`“${finalText || interim}”`);
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') sys(window.isSecureContext ? 'Microphone permission is blocked. Allow it in the browser settings.' : 'Phones only allow the microphone on a secure https link. See the README.');
      else if (!['no-speech', 'aborted'].includes(e.error)) sys('Voice input error: ' + e.error);
    };
    rec.onend = () => {
      state.rec = null;
      setListening(false);
      const t = (finalText || input.value).trim();
      input.value = '';
      if (t) ask(t); else setMode('idle');
    };
    state.rec = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); setMode('idle'); }
  }

  async function recordAndTranscribe() {
    let stream;
    const audio = { echoCancellation: true, noiseSuppression: true };
    if (micId()) audio.deviceId = { exact: micId() };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch {
      try { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); } // chosen mic unplugged
      catch { return sys('I could not use the microphone. Check that this app is allowed to use it.'); }
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    let heard = false;
    unlockAudio();
    const src = actx.createMediaStreamSource(stream);
    const an = actx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    viz.analyser = an;
    viz.data = new Uint8Array(an.frequencyBinCount);
    const td = new Uint8Array(an.fftSize);

    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try { src.disconnect(); } catch {}
      viz.analyser = null;
      state.recorder = null;
      setListening(false);
      if (!heard || !chunks.length) return setMode('idle');
      setMode('thinking');
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      try {
        const r = await api('/stt', { method: 'POST', raw: blob, type: blob.type });
        if (r.error) throw new Error(r.error);
        if (r.text.trim()) ask(r.text); else setMode('idle');
      } catch (e) { setMode('idle'); sys('I did not catch that: ' + e.message); }
    };

    state.recorder = recorder;
    recorder.start(250);
    setListening(true);
    const start = performance.now();
    let lastLoud = start;
    const watch = () => {
      if (!state.listening || recorder.state !== 'recording') return;
      an.getByteTimeDomainData(td);
      let s = 0;
      for (const x of td) { const d = (x - 128) / 128; s += d * d; }
      const rms = Math.sqrt(s / td.length);
      const now = performance.now();
      if (rms > 0.035) { lastLoud = now; heard = true; }
      if ((heard && now - lastLoud > 1500) || now - start > 30000 || (!heard && now - start > 8000)) return stopListening();
      requestAnimationFrame(watch);
    };
    watch();
  }

  function stopListening() {
    if (state.voskActive) { window.wake.cancelCapture(); return; }
    if (state.rec) { try { state.rec.stop(); } catch {} return; }
    if (state.recorder && state.recorder.state === 'recording') { state.recorder.stop(); return; }
    setListening(false);
    setMode('idle');
  }

  // ---------------------------------------------------------------- side panels
  function tickClock() {
    const d = new Date();
    $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  async function loadStats() {
    try {
      const s = await api('/stats');
      $('#cpu-bar').style.width = s.cpu + '%';
      $('#cpu-val').textContent = s.cpu + '%';
      $('#mem-bar').style.width = s.mem + '%';
      $('#mem-val').textContent = s.mem + '%';
      $('#host').textContent = s.host;
      const d = Math.floor(s.uptime / 86400), h = Math.floor((s.uptime % 86400) / 3600), m = Math.floor((s.uptime % 3600) / 60);
      $('#uptime').textContent = (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
    } catch {}
  }

  const wxIcon = c => c <= 1 ? '☀️' : c === 2 ? '⛅' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : c <= 86 ? '❄️' : '⛈️';

  // Phones/other devices can keep their own location; the main computer uses the home city.
  const deviceCity = () => (state.local ? '' : lsGet('jarvis-city', ''));

  async function loadWeather() {
    const boxes = [$('#weather'), $('#weather-m')];
    const show = (cls, html) => boxes.forEach(b => { b.className = cls; b.innerHTML = html; });
    try {
      const w = await api('/weather' + (deviceCity() ? '?city=' + encodeURIComponent(deviceCity()) : ''));
      if (w.error === 'no-city') return show('muted', 'Click here to set your location.');
      if (w.error) throw new Error(w.error);
      show('', `<div class="wx-now"><span class="wx-icon">${wxIcon(w.code)}</span><div><div class="wx-temp">${w.temp}${esc(w.unit)}</div><div class="muted">${esc(w.now.conditions)}</div></div></div>
        <div class="muted" style="font-size:13px;margin-top:4px">${esc(w.place)}</div>
        <div class="wx-days">${w.forecast.map(f => `<div>${new Date(f.date + 'T12:00').toLocaleDateString([], { weekday: 'short' })}<b>${esc(f.high)}</b>${esc(f.low)}</div>`).join('')}</div>`);
    } catch (e) {
      show('muted', /find a place/i.test(e.message) ? esc(e.message) + ' Click to fix it.' : 'Weather unavailable right now.');
    }
  }

  async function changeLocation() {
    if (state.local) return openSettings('you');
    // Other devices: their own city, saved on that device.
    const typed = window.prompt('Your city for weather (leave empty to detect it automatically):', deviceCity());
    if (typed === null) return;
    let city = typed.trim();
    if (!city) {
      const r = await api('/locate').catch(e => ({ error: e.message }));
      if (r.error) return sys(r.error);
      city = r.city;
    }
    lsSet('jarvis-city', city);
    sys(`Location set to ${city}.`);
    loadWeather();
  }
  $$('.weather-card').forEach(c => {
    c.addEventListener('click', changeLocation);
    c.addEventListener('keydown', e => { if (e.key === 'Enter') changeLocation(); });
  });
  $('#detect-city').onclick = async () => {
    $('#detect-status').textContent = 'Detecting…';
    const r = await api('/locate').catch(e => ({ error: e.message }));
    $('#detect-status').textContent = r.error ? r.error : 'Found it. Press Save.';
    if (r.city) F('homeCity').value = r.city;
  };

  function renderTasks(list) {
    const ul = $('#tasks');
    const open = (list || []).filter(t => !t.done);
    const done = (list || []).filter(t => t.done).slice(-3);
    if (!open.length && !done.length) { ul.innerHTML = '<li class="muted">Say "add buy milk to my list".</li>'; return; }
    ul.innerHTML = [...open, ...done].map(t =>
      `<li data-id="${t.id}" class="${t.done ? 'done' : ''}" title="Tap to mark ${t.done ? 'not done' : 'done'}"><span>${esc(t.text)}</span>${t.due ? `<time>${esc(t.due)}</time>` : ''}</li>`).join('');
  }
  $('#tasks').addEventListener('click', async e => {
    const li = e.target.closest('li[data-id]');
    if (li) renderTasks(await api('/tasks/toggle', { method: 'POST', body: { id: Number(li.dataset.id) } }).catch(() => null));
  });

  function renderReminders(list) {
    const ul = $('#reminders');
    if (!list?.length) { ul.innerHTML = '<li class="muted">None set.</li>'; return; }
    ul.innerHTML = list.sort((a, b) => a.due - b.due).map(r =>
      `<li><time>${new Date(r.due).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}${r.deliver === 'call' ? ' · 📞' : r.deliver === 'text' ? ' · 💬' : ''}</time>${esc(r.message)}</li>`).join('');
  }

  // Live events from the server (reminders, tool activity), streamed over fetch.
  async function connectEvents() {
    for (;;) {
      try {
        const res = await fetch('/api/events', { headers: state.pass ? { 'x-jarvis-pass': state.pass } : {} });
        if (!res.ok || !res.body) throw new Error();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let ev = 'message', data = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event: ')) ev = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) { try { onEvent(ev, JSON.parse(data)); } catch {} }
          }
        }
      } catch {}
      await sleep(3000);
    }
  }

  function onEvent(ev, data) {
    if (ev === 'tool' && state.busy) addMsg('tool', (TOOL_LABELS[data.name] || data.name).toUpperCase() + '…');
    else if (ev === 'reminder') {
      const t = `Reminder, ${title()}: ${data.message}`;
      addMsg('jarvis', t);
      speak(t);
      if (!desk && 'Notification' in window && Notification.permission === 'granted') new Notification('Jarvis reminder', { body: data.message });
    } else if (ev === 'reminders') renderReminders(data);
    else if (ev === 'reminder-error') sys('Reminder text/call failed: ' + data.message);
    else if (ev === 'tasks') renderTasks(data);
    else if (ev === 'apple' && data.connected) { sys('✓ Apple Music connected. Try "play some Drake on Apple Music".'); refreshApple(); }
    else if (ev === 'ollama' && state.local) {
      const msg = data.error ? 'Unlimited AI setup failed: ' + data.error : data.done ? '✓ Unlimited AI is ready on this PC' : `Downloading the AI… ${data.progress}%`;
      if ($('#ollama-status')) $('#ollama-status').textContent = msg;
      if (data.done || data.error) sys(data.done ? 'Unlimited offline AI is installed. Free mode will use it whenever the online free AIs hit their limits.' : msg);
    }
    else if (ev === 'tool-step' && state.busy) addMsg('tool', String(data.text).toUpperCase());
    else if (ev === 'voice-setup' && state.local) {
      if (data.message === 'ready') { if (state.voiceDownloading) sys('Voice ready.'); state.voiceDownloading = false; }
      else if (data.message.startsWith('failed')) sys(`Couldn't set up the British voice (${data.message.slice(8)}). Using the built-in voice for now.`);
      else if (!state.voiceDownloading) { state.voiceDownloading = true; sys(`Setting up ${aiName()}'s voice: ${data.message}`); }
    }
    else if (ev === 'routine') {
      addMsg('system', `Routine done: ${data.instruction}`);
      const el = addMsg('jarvis', data.reply);
      window.holo?.typeOut(el.querySelector('.body'));
      speak(data.reply);
    }
    else if (ev === 'spotify') { loadSettings(); sys('Spotify connected.'); }
  }

  // ---------------------------------------------------------------- settings
  const MODELS = {
    free: [],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'],
    anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    grok: ['grok-4', 'grok-3', 'grok-3-mini'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash', 'x-ai/grok-4', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat'],
    ollama: ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral', 'gemma2'],
    custom: [],
  };
  const PROVIDER_HINTS = {
    free: '',
    groq: 'Free key, no credit card: console.groq.com/keys. Very fast. Paste it under API keys → Groq.',
    openai: 'Get a key at platform.openai.com/api-keys. The same key also powers the best Jarvis voice and voice input.',
    anthropic: 'Get a key at console.anthropic.com.',
    grok: 'Get a key at console.x.ai.',
    gemini: 'Get a free key at aistudio.google.com/apikey.',
    openrouter: 'One key for hundreds of models (ChatGPT, Claude, Grok, Llama, DeepSeek...). openrouter.ai/keys.',
    ollama: 'Free and private: install Ollama from ollama.com, then run "ollama pull llama3.1". No key needed.',
    custom: 'Any service with an OpenAI-compatible API (LM Studio, Together, Groq, Mistral, DeepSeek...).',
  };
  const KEY_INFO = [
    ['openai', 'OpenAI (ChatGPT, voice, listening)', 'https://platform.openai.com/api-keys'],
    ['anthropic', 'Anthropic (Claude)', 'https://console.anthropic.com/settings/keys'],
    ['grok', 'xAI (Grok)', 'https://console.x.ai'],
    ['gemini', 'Google Gemini', 'https://aistudio.google.com/apikey'],
    ['openrouter', 'OpenRouter', 'https://openrouter.ai/keys'],
    ['custom', 'Other provider', ''],
    ['groq', 'Groq (FREE AI + free voice listening)', 'https://console.groq.com/keys'],
    ['cerebras', 'Cerebras (FREE AI)', 'https://cloud.cerebras.ai'],
    ['mistral', 'Mistral (FREE AI)', 'https://console.mistral.ai/api-keys'],
    ['elevenlabs', 'ElevenLabs (voices)', 'https://elevenlabs.io/app/settings/api-keys'],
    ['tavily', 'Tavily (better web research, free tier)', 'https://app.tavily.com'],
    ['brave', 'Brave Search (web research)', 'https://api-dashboard.search.brave.com'],
  ];

  const form = $('#settings-form');
  const F = name => form.elements[name];

  async function loadSettings() {
    state.settings = await api('/settings');
    const s = state.settings;
    applyName();
    $('#provider-label').textContent = `${s.providerName || s.provider} · ${s.models[s.provider] || ''}`;
    return s;
  }

  function showWhen() {
    const p = F('provider').value;
    $$('.only-custom').forEach(el => { el.hidden = p !== 'custom'; });
    $$('.only-ollama').forEach(el => { el.hidden = p !== 'ollama'; });
    $$('.only-free').forEach(el => { el.hidden = p !== 'free'; });
    $$('.not-free').forEach(el => { el.hidden = p === 'free'; });
    const has = state.settings?.hasKey || {};
    for (const k of ['groq', 'cerebras', 'gemini', 'mistral', 'openrouter']) $('#free-' + k).textContent = has[k] ? '✓ saved' : '';
    if (p === 'free' && state.local) refreshOllama();
    const ve = F('voiceEngine').value;
    $$('.only-system').forEach(el => { el.hidden = ve !== 'system'; });
    $$('.only-piper').forEach(el => { el.hidden = ve !== 'piper' && !(el.classList.contains('only-system') && ve === 'system'); });
    $$('.only-system.only-piper').forEach(el => { el.hidden = ve !== 'system' && ve !== 'piper'; });
    $$('.only-openai').forEach(el => { el.hidden = ve !== 'openai'; });
    $$('.only-elevenlabs').forEach(el => { el.hidden = ve !== 'elevenlabs'; });
    $$('.only-emailcustom').forEach(el => { el.hidden = F('emailPreset').value !== 'custom'; });
    $$('.only-desktop').forEach(el => { el.hidden = !desk; });
    $('#provider-hint').textContent = PROVIDER_HINTS[p] || '';
    $('#model-list').innerHTML = (MODELS[p] || []).map(m => `<option value="${esc(m)}">`).join('');
  }

  function fillVoices() {
    const sel = F('systemVoice');
    const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
    const cur = state.settings?.voice?.systemVoice || '';
    sel.innerHTML = '<option value="">Automatic (British if available)</option>' +
      voices.map(v => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    sel.value = cur;
  }
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillVoices;

  async function openSettings(tab) {
    const s = await loadSettings().catch(e => { sys(e.message); return null; });
    if (!s) return;
    state.formModels = { ...s.models };
    F('provider').value = s.provider;
    F('model').value = s.models[s.provider] || '';
    F('customBaseUrl').value = s.customBaseUrl || '';
    F('browser').value = s.browser || 'auto';
    F('ollamaUrl').value = s.ollamaUrl || '';
    refreshFast();
    refreshMail();
    F('assistantName').value = s.assistantName || 'Jarvis';
    F('userName').value = s.userName || '';
    F('namePronounce').value = s.namePronounce || '';
    F('userTitle').value = s.userTitle || '';
    F('homeCity').value = s.homeCity || '';
    F('units').value = s.units;
    F('voiceEngine').value = s.voice.engine;
    await fillPiperVoices();
    F('rate').value = s.voice.rate;
    F('pitch').value = s.voice.pitch;
    F('openaiVoice').value = s.voice.openaiVoice;
    F('elevenVoiceId').value = s.voice.elevenVoiceId || '';
    F('sttEngine').value = s.sttEngine;
    F('sttLanguage').value = s.sttLanguage || 'auto';
    F('sttWords').value = s.sttWords || '';
    F('emailPreset').value = s.email.preset;
    F('emailUser').value = s.email.user || '';
    F('imapHost').value = s.email.imapHost || '';
    F('imapPort').value = s.email.imapPort || 993;
    F('smtpHost').value = s.email.smtpHost || '';
    F('smtpPort').value = s.email.smtpPort || 465;
    F('key-email').placeholder = s.hasKey.email ? 'saved ✓ (leave empty to keep)' : 'app password';
    F('musicService').value = s.music.service;
    F('spotifyClientId').value = s.music.spotifyClientId || '';
    $('#spotify-status').textContent = s.spotifyConnected ? 'Connected ✓' : 'Not connected';
    if (state.local) refreshApple();
    const port = location.port || '7777';
    $('#spotify-help').innerHTML = `Setup once: go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> → Create app → add redirect URI <code>http://127.0.0.1:${esc(port)}/api/spotify/callback</code> → tick "Web API" → copy the Client ID here → Save → Connect Spotify. Playback control needs Spotify Premium.`;
    F('myNumber').value = s.phone.myNumber || '';
    F('twilioSid').value = s.phone.twilioSid || '';
    F('twilioFrom').value = s.phone.twilioFrom || '';
    F('key-twilio').placeholder = s.hasKey.twilio ? 'saved ✓ (leave empty to keep)' : 'auth token';
    F('alpacaMode').value = s.trading?.alpacaMode || 'paper';
    F('oandaMode').value = s.trading?.oandaMode || 'practice';
    F('oandaAccount').value = s.trading?.oandaAccount || '';
    F('liveConfirmed').checked = !!s.trading?.liveConfirmed;
    for (const k of ['alpacaKey', 'alpacaSecret', 'oandaToken']) F('key-' + k).placeholder = s.hasKey[k] ? 'saved ✓ (leave empty to keep)' : 'paste here';
    F('remoteEnabled').checked = s.remote.enabled;
    F('remotePasscode').placeholder = s.remote.hasPasscode ? 'saved ✓ (leave empty to keep)' : 'choose a passcode';
    F('remotePasscode').value = '';
    F('deviceMute').checked = state.muted;
    F('voiceFx').checked = lsGet('jarvis-voicefx', '1') === '1';
    fillAudioDevices();
    if (desk?.updateState) desk.updateState().then(renderUpdate);
    else { $('#upd-status').textContent = 'Updates are installed by the Jarvis app on each computer.'; $('#upd-check').hidden = true; }
    if (desk?.getTray) F('keepInTray').checked = (await desk.getTray()).keep;
    if (desk?.getAutoStart) {
      const a = await desk.getAutoStart();
      F('autoStart').checked = a.on;
      F('autoStart').disabled = !a.available;
      $('#autostart-hint').hidden = a.available;
    }
    if (desk?.getDisplays) {
      const d = await desk.getDisplays();
      F('displayMode').value = d.mode;
      F('clickThrough').checked = d.clickThrough;
      $('#monitor-count').textContent = `(${d.count} detected)`;
    }
    F('listenMode').value = listenMode();
    for (const o of F('listenMode').options) o.disabled = o.value !== 'button' && !window.wake?.supported;
    F('glass').value = lsGet('jarvis-glass', '40');
    F('bgStyle').value = lsGet('jarvis-bg', 'clear');
    F('onTop').checked = lsGet('jarvis-ontop') === '1';

    $('#keys').innerHTML = KEY_INFO.map(([k, label, link]) => `
      <div class="key-row"><label>
        <span class="lbl"><span>${esc(label)} ${s.hasKey[k] ? '<span class="saved">saved ✓</span>' : ''}</span>${link ? `<a href="${link}" target="_blank" rel="noopener">get key</a>` : ''}</span>
        <input type="password" name="key-${k}" autocomplete="off" spellcheck="false" placeholder="${s.hasKey[k] ? 'leave empty to keep' : 'paste key'}">
      </label></div>`).join('');

    for (const k of KEY_INFO.map(x => x[0]).concat(['email', 'twilio'])) { if (F('key-' + k)) F('key-' + k).value = ''; }

    $('#remote-notice').hidden = state.local;
    $$('#settings-form .tab input, #settings-form .tab select, #settings-form .tab button').forEach(el => {
      el.disabled = !state.local && !el.closest('[data-tab="device"]');
    });
    fillVoices();
    showWhen();
    showLan();
    // Start where it helps most: the fast-mode steps until a free key is added.
    switchTab(tab || (!state.local ? 'device' : s.provider === 'free' && !hasFastAI() ? 'fast' : 'ai'));
    $('#settings').showModal();
  }

  async function showLan() {
    const box = $('#lan-urls');
    if (!state.local) { box.textContent = ''; return; }
    try {
      const n = await api('/network');
      box.innerHTML = n.urls.length
        ? 'Open this on a phone on the same Wi-Fi: ' + n.urls.map(u => `<code>${esc(u)}</code>`).join(' or ')
        : 'Turn this on and Save to get a link for phones.';
    } catch { box.textContent = ''; }
  }

  function switchTab(name) {
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('#settings-form .tab').forEach(t => { t.hidden = t.dataset.tab !== name; });
  }

  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); });
  F('provider').addEventListener('focus', () => { state.prevProvider = F('provider').value; });
  F('provider').addEventListener('change', () => {
    if (state.prevProvider) state.formModels[state.prevProvider] = F('model').value.trim();
    state.prevProvider = F('provider').value;
    F('model').value = state.formModels[F('provider').value] || MODELS[F('provider').value]?.[0] || '';
    showWhen();
  });
  ['voiceEngine', 'emailPreset'].forEach(n => F(n).addEventListener('change', showWhen));
  F('glass').addEventListener('input', () => applyGlass(F('glass').value));
  F('bgStyle').addEventListener('change', () => applyBackground(F('bgStyle').value)); // live preview

  // Background: clear hologram, frosted (system blur behind the window) or solid.
  let blurOn = false;
  async function applyBackground(style = lsGet('jarvis-bg', 'clear')) {
    if (!desk) return;
    document.body.dataset.bg = style;
    blurOn = desk.setBackground ? (await desk.setBackground(style)).blur : false;
    applyGlass(lsGet('jarvis-glass', '40'));
  }
  function applyGlass(v) {
    if (!desk) return;
    const style = document.body.dataset.bg || 'clear';
    let solid = 1 - Number(v) / 100;
    if (style === 'solid') solid = 1;
    // Frosted: with real blur keep a light tint; without it, darken so text stays readable.
    if (style === 'frosted') solid = blurOn ? Math.max(0.15, solid * 0.6) : Math.max(0.78, solid);
    document.body.style.setProperty('--solid', solid.toFixed(2));
  }

  // 'name' = only the wake word opens the mic (default in the desktop app),
  // 'both' = wake word or mic button, 'button' = mic button only (default on phones, saves battery).
  function listenMode() {
    const saved = lsGet('jarvis-listen', '');
    if (saved) return saved;
    if (lsGet('jarvis-wake') === '0') return 'button'; // older setting: wake word was switched off
    return desk ? 'name' : 'button';
  }
  const wakeWanted = () => listenMode() !== 'button';
  function applyListenMode() {
    const nameOnly = listenMode() === 'name';
    micBtn.classList.toggle('name-only', nameOnly);
    if (!state.micOff) micBtn.title = nameOnly ? `Listening only for "${aiName()}"` : 'Talk (Ctrl+Shift+J)';
  }

  async function saveDevice() {
    if (F('listenMode').value !== listenMode()) {
      const before = wakeWanted();
      lsSet('jarvis-listen', F('listenMode').value);
      if (wakeWanted() !== before) setWake(wakeWanted());
      applyListenMode();
    }
    state.muted = F('deviceMute').checked;
    lsSet('jarvis-mute', state.muted ? '1' : '0');
    lsSet('jarvis-voicefx', F('voiceFx').checked ? '1' : '0');
    if (F('micId').value !== micId()) {
      lsSet('jarvis-mic', F('micId').value);
      window.wake?.setMic(F('micId').value).catch(() => {});
    }
    if (F('speakerId').value !== lsGet('jarvis-speaker', '')) {
      lsSet('jarvis-speaker', F('speakerId').value);
      applySpeaker();
    }
    updateMute();
    if (desk?.setTray) await desk.setTray(F('keepInTray').checked);
    if (desk?.setAutoStart && !F('autoStart').disabled) await desk.setAutoStart(F('autoStart').checked);
    if (desk?.setDisplays) await desk.setDisplays({ mode: F('displayMode').value, clickThrough: F('clickThrough').checked });
    if (desk) {
      lsSet('jarvis-glass', F('glass').value);
      lsSet('jarvis-bg', F('bgStyle').value);
      await applyBackground(F('bgStyle').value);
      lsSet('jarvis-ontop', F('onTop').checked ? '1' : '0');
      const on = await desk.setOnTop(F('onTop').checked);
      $('#pin-btn').classList.toggle('on', !!on);
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    await saveDevice();
    if (!state.local) { $('#settings').close(); return; }
    const p = F('provider').value;
    state.formModels[p] = F('model').value.trim();
    const keys = {};
    $$('#settings-form input[name^="key-"]').forEach(i => { if (i.value.trim()) keys[i.name.slice(4)] = i.value.trim(); });
    if (F('remoteEnabled').checked && !F('remotePasscode').value.trim() && !state.settings.remote.hasPasscode) {
      switchTab('access');
      F('remotePasscode').focus();
      return sys('Choose a passcode before letting other devices use Jarvis.');
    }
    const patch = {
      provider: p, models: state.formModels,
      browser: F('browser').value,
      customBaseUrl: F('customBaseUrl').value.trim(), ollamaUrl: F('ollamaUrl').value.trim(),
      assistantName: F('assistantName').value.trim().replace(/[^\p{L}\p{N} '-]/gu, '').slice(0, 20) || 'Jarvis',
      userName: F('userName').value.trim(), namePronounce: F('namePronounce').value.trim(), userTitle: F('userTitle').value.trim() || 'sir',
      homeCity: F('homeCity').value.trim(), units: F('units').value,
      voice: {
        engine: F('voiceEngine').value, piperVoice: F('piperVoice').value || 'alan', systemVoice: F('systemVoice').value, rate: Number(F('rate').value), pitch: Number(F('pitch').value),
        openaiVoice: F('openaiVoice').value, elevenVoiceId: F('elevenVoiceId').value.trim(),
      },
      sttEngine: F('sttEngine').value,
      sttLanguage: F('sttLanguage').value,
      sttWords: F('sttWords').value.trim().slice(0, 400),
      email: {
        preset: F('emailPreset').value, user: F('emailUser').value.trim(),
        imapHost: F('imapHost').value.trim(), imapPort: Number(F('imapPort').value) || 993,
        smtpHost: F('smtpHost').value.trim(), smtpPort: Number(F('smtpPort').value) || 465,
      },
      music: { service: F('musicService').value, spotifyClientId: F('spotifyClientId').value.trim() },
      trading: {
        alpacaMode: F('alpacaMode').value, oandaMode: F('oandaMode').value,
        oandaAccount: F('oandaAccount').value.trim(), liveConfirmed: F('liveConfirmed').checked,
      },
      phone: { myNumber: F('myNumber').value.trim(), twilioSid: F('twilioSid').value.trim(), twilioFrom: F('twilioFrom').value.trim() },
      remote: { enabled: F('remoteEnabled').checked, passcode: F('remotePasscode').value },
      keys,
    };
    const renamed = patch.assistantName !== aiName();
    try {
      await api('/settings', { method: 'POST', body: patch });
      await loadSettings();
      if (renamed && window.wake?.running) setWake(true); // listen for the new name
      $('#settings').close();
      sys('Settings saved.');
      loadWeather();
    } catch (err) { sys('Could not save: ' + err.message); }
  });

  $('#settings-cancel').onclick = () => $('#settings').close();
  $('#settings-x').onclick = () => $('#settings').close();
  $('#settings-btn').onclick = () => openSettings();
  $('#clear-keys').onclick = async () => {
    if (!confirm('Remove every saved API key, email password and the Spotify connection from this computer?')) return;
    await api('/settings/clear-keys', { method: 'POST' });
    $('#settings').close();
    sys('All keys removed.');
  };
  $('#forget-pass').onclick = () => { lsDel('jarvis-pass'); state.pass = ''; sys('Passcode forgotten on this device.'); };
  $('#test-voice').onclick = async () => {
    unlockAudio();
    const prev = state.settings.voice;
    const preview = {
      engine: F('voiceEngine').value, piperVoice: F('piperVoice').value, openaiVoice: F('openaiVoice').value,
      elevenVoiceId: F('elevenVoiceId').value.trim(), rate: Number(F('rate').value),
    };
    state.settings.voice = { ...prev, ...preview, systemVoice: F('systemVoice').value, pitch: F('pitch').value };
    const wasMuted = state.muted;
    state.muted = false;
    const btn = $('#test-voice');
    btn.disabled = true;
    btn.textContent = preview.engine === 'piper' ? 'Preparing voice… (first time downloads it)' : 'Speaking…';
    await speak(`Good evening, ${F('userName').value || F('userTitle').value || 'sir'}. All systems are online, and I am at your service.`, preview);
    btn.disabled = false;
    btn.textContent = 'Test voice';
    state.muted = wasMuted;
    state.settings.voice = prev;
  };

  // ---- Email: guided setup (address -> provider's app-password page -> paste & test)
  const openLink = url => { if (desk) desk.openExternal(url); else window.open(url, '_blank', 'noopener'); };
  function refreshMail() {
    const s = state.settings || {};
    const connected = !!(s.email?.user && s.hasKey?.email);
    $('#mail-connected').hidden = !connected;
    $('#mail-setup').hidden = connected;
    if (connected) $('#mail-connected-text').textContent = `✓ Connected: ${s.email.user}. Ask "any new emails?"`;
  }
  let mailInfo = null;
  async function mailNext() {
    const address = $('#mail-address').value.trim();
    const out = $('#mail-detected');
    out.className = 'hint';
    out.textContent = 'Looking up your email provider…';
    $('#mail-step2').hidden = $('#mail-step3').hidden = true;
    const d = await api('/email/detect?address=' + encodeURIComponent(address)).catch(e => ({ error: e.message }));
    if (d.error) { out.textContent = d.error; out.className = 'hint bad'; return; }
    mailInfo = d;
    const g = d.guide || {};
    if (g.oauthOnly) { out.textContent = g.note; out.className = 'hint bad'; return; }
    out.textContent = `✓ ${g.name} found.`;
    out.className = 'hint good';
    $('#mail-before').hidden = !g.before;
    if (g.before) {
      $('#mail-before-text').textContent = g.before.text;
      $('#mail-before-btn').textContent = g.before.button + ' ↗';
      $('#mail-before-btn').onclick = () => openLink(g.before.url);
    }
    $('#mail-open').hidden = !g.url;
    $('#mail-open').textContent = (g.button || 'Open') + ' ↗';
    $('#mail-open').onclick = () => openLink(g.url);
    $('#mail-why').hidden = d.preset === 'custom';
    $('#mail-steps').innerHTML = (g.steps || []).map(x => `<li>${esc(x)}</li>`).join('');
    $('#mail-step2').hidden = false;
    $('#mail-step3').hidden = false;
    $('#mail-pass').placeholder = d.preset === 'custom' ? 'Your email password' : 'Paste the app password here';
  }
  $('#mail-next').onclick = mailNext;
  $('#mail-address').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mailNext(); } });
  $('#mail-connect').onclick = async () => {
    const out = $('#mail-result');
    if (!mailInfo) return mailNext();
    out.className = 'hint';
    out.textContent = 'Signing in to check it works…';
    const r = await api('/email/connect', { method: 'POST', body: { email: mailInfo.email, password: $('#mail-pass').value } }).catch(e => ({ error: e.message }));
    if (!r.ok) { out.textContent = r.error; out.className = 'hint bad'; return; }
    $('#mail-pass').value = '';
    out.textContent = r.canSend ? '✓ Connected! Jarvis can read and send email.' : '✓ Connected for reading. (Sending didn\'t check out; replies may not send.)';
    out.className = 'hint good';
    await loadSettings();
    refreshMail();
    sys(`✉️ Email connected (${r.email}). Try "any new emails?"`);
  };
  $('#mail-change').onclick = () => { $('#mail-connected').hidden = true; $('#mail-setup').hidden = false; $('#mail-address').focus(); };
  $('#mail-disconnect').onclick = async () => {
    await api('/email/disconnect', { method: 'POST' });
    await loadSettings();
    refreshMail();
  };
  $('#mail-pass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#mail-connect').click(); } });

  // ---- "Make it fast (free)": guided free Groq key
  const hasFastAI = () => ['groq', 'cerebras', 'gemini', 'mistral', 'openrouter'].some(k => state.settings?.hasKey?.[k]);
  function refreshFast() {
    const el = $('#fast-status');
    const fast = hasFastAI();
    el.textContent = fast ? '✓ Fast mode is ON: answers come back in about a second.' : '⚠ Jarvis is on the slow free starter AI right now. Follow the 4 steps below to make him fast, for free.';
    el.className = 'fast-status' + (fast ? ' good' : '');
  }
  $('#groq-open').onclick = () => {
    const url = 'https://console.groq.com/keys';
    if (desk) desk.openExternal(url); else window.open(url, '_blank', 'noopener');
  };
  $('#groq-save').onclick = async () => {
    const out = $('#groq-result');
    const key = $('#groq-paste').value.trim();
    if (!key) { out.textContent = 'Paste the key first.'; out.className = 'hint bad'; return; }
    out.textContent = 'Testing the key…';
    out.className = 'hint';
    const r = await api('/keys/test', { method: 'POST', body: { provider: 'groq', key } }).catch(e => ({ error: e.message }));
    if (!r.ok) { out.textContent = r.error || 'That key did not work.'; out.className = 'hint bad'; return; }
    $('#groq-paste').value = '';
    out.textContent = '✓ Key works and is saved. Jarvis is now fast!';
    out.className = 'hint good';
    await loadSettings();
    refreshFast();
    showWhen();
    sys('⚡ Fast mode is on. Try asking me something.');
  };
  // A button inside a chat message that opens Settings at "Make it fast".
  function fastTip(text) {
    const el = sys(text);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = '⚡ Make Jarvis fast (free)';
    b.onclick = () => openSettings('fast');
    const row = document.createElement('div');
    row.className = 'chips';
    row.append(b);
    el.querySelector('.body').append(row);
  }

  // ---- unlimited offline AI (Ollama)
  async function refreshOllama() {
    const st = await api('/ollama/status').catch(() => ({ running: false }));
    $('#ollama-status').textContent = st.ready ? '✓ Unlimited AI is ready on this PC' : st.running ? 'Ollama is installed: press the button to download the AI.' : 'Step 1: install Ollama (free), then press the button.';
    $('#ollama-setup').hidden = !!st.ready;
  }
  $('#ollama-setup').onclick = async () => {
    const r = await api('/ollama/setup', { method: 'POST' }).catch(e => ({ error: e.message }));
    if (r.needsInstall) {
      $('#ollama-status').textContent = 'Install Ollama from the page that just opened, start it, then press the button again.';
      openUrl(r.url);
      if (!desk && isTouch) window.open(r.url, '_blank');
    } else if (r.started) {
      $('#ollama-status').textContent = 'Downloading the AI (about 5 GB)… you can keep using Jarvis meanwhile.';
    } else if (r.error) $('#ollama-status').textContent = r.error;
  };

  async function fillPiperVoices() {
    const sel = F('piperVoice');
    if (!sel.options.length) {
      try {
        const { piper } = await api('/voices');
        const groups = [...new Set(piper.map(v => v.group))];
        sel.innerHTML = groups.map(g => `<optgroup label="${esc(g)}">${piper.filter(v => v.group === g).map(v => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('')}</optgroup>`).join('');
        if (!piper.length) F('voiceEngine').querySelector('option[value="piper"]').disabled = true;
      } catch {}
    }
    sel.value = state.settings?.voice?.piperVoice || 'alan';
  }
  $('#test-name').onclick = async () => {
    unlockAudio();
    const name = F('userName').value.trim();
    if (!name) return sys('Type your name first.');
    const prev = { ...state.settings };
    state.settings.userName = name;
    state.settings.namePronounce = F('namePronounce').value.trim();
    const wasMuted = state.muted;
    state.muted = false;
    await speak(`Good to meet you, ${name}. I'll remember that.`);
    state.muted = wasMuted;
    state.settings.userName = prev.userName;
    state.settings.namePronounce = prev.namePronounce;
  };
  $('#spotify-connect').onclick = () => {
    if (!F('spotifyClientId').value.trim()) return sys('Paste your Spotify Client ID and press Save first.');
    const url = `http://127.0.0.1:${location.port || 7777}/api/spotify/login`;
    if (desk) desk.openExternal(url); else window.open(url, '_blank');
    sys('Finish the Spotify login in your browser, then come back.');
  };
  // ---- Apple Music
  async function refreshApple() {
    const st = await api('/apple/status').catch(() => null);
    if (!st) return;
    $('#apple-status').textContent = st.webConnected ? '✓ Connected: Jarvis can search and play Apple Music for you.' : 'Not connected yet.';
    $('#apple-status').className = 'update-status ' + (st.webConnected ? 'good' : '');
    $('#apple-connect').hidden = st.webConnected;
    $('#apple-disconnect').hidden = !st.webConnected;
    const p = st.playing;
    $('#apple-playing').textContent = p?.track ? `${p.status === 'Playing' || p.playing ? '▶ Now playing' : '⏸ Paused'}: ${p.track}${p.artist ? ' · ' + p.artist : ''}` : '';
  }
  $('#apple-connect').onclick = async () => {
    $('#apple-status').textContent = 'Opening Apple Music… sign in with your Apple ID in the browser window.';
    const r = await api('/apple/connect', { method: 'POST' }).catch(e => ({ error: e.message }));
    if (r.error) $('#apple-status').textContent = r.error;
  };
  $('#apple-disconnect').onclick = async () => { await api('/apple/disconnect', { method: 'POST' }); refreshApple(); };
  $('#apple-refresh').onclick = refreshApple;

  $('#spotify-disconnect').onclick = async () => {
    await api('/spotify/disconnect', { method: 'POST' });
    $('#spotify-status').textContent = 'Not connected';
  };

  // ---------------------------------------------------------------- controls
  function updateMute() {
    $('#mute-btn').textContent = state.muted ? '🔇' : '🔊';
    $('#mute-btn').title = state.muted ? 'Unmute voice' : 'Mute voice';
  }
  $('#mute-btn').onclick = () => {
    state.muted = !state.muted;
    lsSet('jarvis-mute', state.muted ? '1' : '0');
    if (state.muted) stopSpeaking();
    updateMute();
  };
  $('#drawer-btn').onclick = () => document.body.classList.toggle('drawer');
  $('#input-bar').addEventListener('submit', e => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    ask(t);
  });
  micBtn.onclick = toggleListen;
  $('.quick').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    document.body.classList.remove('drawer');
    if (b.dataset.ask) ask(b.dataset.ask);
    else { input.value = b.dataset.fill; input.focus(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { stopSpeaking(); if (state.listening) stopListening(); }
  });

  // ---- free updates: top-bar button + Settings → Updates show the same status
  let lastUpdate = {};
  function renderUpdate(u) {
    if (!u) return;
    lastUpdate = { ...lastUpdate, ...u };
    u = lastUpdate;
    const isMac = u.platform === 'darwin';
    const top = $('#update-btn'), status = $('#upd-status'), action = $('#upd-action');
    if (u.current) $('#upd-current').textContent = 'v' + u.current;
    const msg = {
      idle: ['Not checked yet.', ''], checking: ['Checking for updates…', ''],
      none: ['✓ You have the latest version.', 'good'],
      available: [`New version v${u.version} is available.`, 'new'],
      downloading: [`Downloading v${u.version || ''}… ${u.percent || 0}%`, 'new'],
      ready: [`✓ v${u.version} is downloaded and ready to install.`, 'new'],
      error: [`Couldn't check for updates: ${u.error || 'no connection'}`, 'bad'],
      unavailable: ['Updates work in the installed app (not in this test copy).', ''],
    }[u.state] || ['', ''];
    status.textContent = msg[0];
    status.className = 'update-status ' + msg[1];
    $('#upd-bar').hidden = u.state !== 'downloading';
    $('#upd-fill').style.width = (u.percent || 0) + '%';
    action.hidden = !['available', 'ready'].includes(u.state);
    action.textContent = u.state === 'ready' ? 'Restart & update now' : isMac ? 'Download update' : 'Download now';
    action.onclick = u.state === 'ready' ? () => desk.installUpdate() : () => (isMac ? desk.openUpdatePage() : desk.checkUpdate());
    $('#upd-check').disabled = ['checking', 'downloading'].includes(u.state);
    $('#update-dot').hidden = !['available', 'downloading', 'ready'].includes(u.state);

    // Small orange button in the top bar while an update is coming or ready.
    top.hidden = !['available', 'downloading', 'ready'].includes(u.state);
    top.classList.toggle('busy', u.state === 'downloading');
    top.textContent = u.state === 'ready' ? `UPDATE v${u.version} · RESTART` : u.state === 'available' ? `v${u.version} AVAILABLE` : `DOWNLOADING ${u.percent || 0}%`;
    top.onclick = u.state === 'ready' ? () => desk.installUpdate() : () => openSettings('updates');
    if (u.state === 'ready' && !renderUpdate.told) {
      renderUpdate.told = true;
      sys(`Version ${u.version} is ready. Press the orange button at the top (or Settings → Updates) to restart and update.`);
    }
  }
  $('#upd-check').onclick = () => {
    if (!desk?.checkUpdate) return;
    renderUpdate({ state: 'checking' });
    desk.checkUpdate();
  };

  function setupDesktop() {
    document.body.classList.add('desktop');
    $('#win-controls').hidden = false;
    $('#min-btn').onclick = () => desk.minimize();
    $('#max-btn').onclick = () => desk.maximize();
    $('#close-btn').onclick = () => desk.close();
    $('#pin-btn').onclick = async () => {
      const on = await desk.setOnTop(!$('#pin-btn').classList.contains('on'));
      $('#pin-btn').classList.toggle('on', !!on);
      lsSet('jarvis-ontop', on ? '1' : '0');
    };
    desk.onHotkey(() => toggleListen());
    desk.onWindowState(s => document.body.classList.toggle('maximized', s.maximized));
    desk.version?.().then(v => { $('#app-version').textContent = 'v' + v; });
    // Free updates: Windows downloads in the background; Macs get a download link.
    desk.onUpdate?.(renderUpdate);
    desk.updateState?.().then(renderUpdate);
    applyBackground();
    if (lsGet('jarvis-ontop') === '1') desk.setOnTop(true).then(on => $('#pin-btn').classList.toggle('on', !!on));
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  // ---------------------------------------------------------------- start up
  async function boot() {
    if (desk) setupDesktop();
    updateMute();
    applyMicSwitch();
    tickClock();
    setInterval(tickClock, 1000);

    const hello = await fetch('/api/hello', { headers: state.pass ? { 'x-jarvis-pass': state.pass } : {} }).then(r => r.json()).catch(() => null);
    if (!hello) { setMode('error'); return sys("I can't reach the main computer. Make sure Jarvis is running there."); }
    state.local = hello.local;
    document.body.classList.toggle('remote', !hello.local);
    if (hello.status === 'off') { $('#lock-form').querySelector('input').hidden = true; $('#lock-form').querySelector('button').hidden = true; await askPasscode('Remote access is turned off. Turn it on in Settings → Phone access on the main computer.'); }
    if (hello.status === 'locked') await askPasscode('Too many wrong tries. Wait 10 minutes.');
    else if (hello.status !== 'ok') await askPasscode(state.pass ? 'That passcode no longer works. Enter the new one.' : 'Enter the passcode to continue.');

    try { await loadSettings(); } catch (e) { document.body.classList.add('booted'); return sys(e.message); }
    if (state.local && state.settings.voice.engine === 'piper') api('/voice/prepare', { method: 'POST' }).catch(() => {});
    // Speak the welcome while the boot animation is still running.
    const who = state.settings.userName || state.settings.userTitle || 'sir';
    if (window.holo) window.holo.userName = state.settings.userName || '';
    caption('');
    if (desk) speak(`Welcome back, ${who}. All systems are coming online.`);
    loadStats();
    setInterval(loadStats, 3000);
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000);
    api('/reminders').then(renderReminders).catch(() => {});
    api('/tasks').then(renderTasks).catch(() => {});
    connectEvents();
    if (!desk && 'Notification' in window && Notification.permission === 'default') {
      document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
    }

    await window.holo?.bootDone;
    document.body.classList.add('booted');
    const s = state.settings;
    const hi = `${greeting()}, ${s.userName || s.userTitle || 'sir'}. All systems are online.`;
    window.holo?.typeOut(addMsg('jarvis', hi).querySelector('.body'));

    applyListenMode();
    if (wakeWanted()) {
      // Browsers only allow the mic/audio after a tap; the desktop app can start right away.
      if (desk) setWake(true);
      else document.addEventListener('click', () => setWake(true), { once: true });
    }

    const needsKey = !['free', 'ollama', 'custom'].includes(s.provider) && !s.hasKey[s.provider];
    if (s.provider === 'free' && !hasFastAI() && state.local) {
      fastTip("I'm running on the free starter AI, so my answers are slow. A free Groq key (no credit card, about 2 minutes) makes me answer in about a second.");
    }
    if (needsKey && state.local) {
      sys('Welcome. To give Jarvis a brain, choose an AI platform and paste its API key. Opening Settings now.');
      setTimeout(() => openSettings('ai'), 600);
    }
  }

  boot();
})();
