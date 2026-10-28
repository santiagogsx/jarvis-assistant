// The Jarvis web server. The desktop app loads it locally; phones and other
// browsers reach it over Wi-Fi (or an https tunnel) and must enter the
// passcode the owner set. Settings can only be changed on the main computer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { chat, NAMES } = require('./providers');
const { createTools } = require('./tools');
const { createMusic } = require('./music');
const voice = require('./voice');
const email = require('./email');
const research = require('./research');
const { createPiper } = require('./piper');
const { createVoskModels } = require('./voskmodels');
const { createBrowser } = require('./browser');
const { createTrading } = require('./trading');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function systemPrompt(s, local) {
  const name = s.userName ? ` Their name is ${s.userName}: use it naturally now and then (e.g. "Right away, ${s.userName}." or "Good morning, ${s.userName}."), not in every sentence.` : '';
  const me = (s.assistantName || 'Jarvis').trim();
  const intro = /^jarvis$/i.test(me) ? 'You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), a personal AI assistant.' : `You are ${me}, a personal AI assistant. Your name is ${me}.`;
  return `${intro}
Personality: calm, polite, efficient and capable, with dry, understated British wit. Address the person as "${s.userTitle || 'sir'}".${name}
Your replies are read aloud, so:
- Lead with a short spoken answer (1-3 sentences). Add detail after only when it helps.
- No tables, no headings, no emoji. Short bullet lists are fine for research results.
- Always reply in the language the person writes or speaks to you in.
- Spoken requests are transcribed by speech recognition and may contain mis-heard words; work out what they most likely meant from context (accents, names, homophones) instead of taking odd words literally.
You can act through tools: weather, web research, news, email, music, reminders, notes, social media, shopping, texting/calling the owner's phone, opening sites and apps.
- Phone: text_me / call_me reach only the owner's own phone. For "call me in 20 minutes" use set_reminder with deliver=call.
- Tasks: keep the to-do list with add_task/list_tasks/complete_task. For anything that should happen automatically at a time or on repeat ("every morning at 8, text me the weather"), use schedule_routine with a clear instruction. create_file writes documents into the Jarvis folder in Documents.
- Multi-step requests: break them into steps and use as many tools as needed, then report what you did.
- Live browser (browser_* tools): use it when the person wants to watch you research on their computer ("open the browser", "show me", "look it up on my computer"). Search, open the most promising results, read them, then summarize with sources. Never log in, never type passwords or payment details, and never place orders or submit forms that spend money: hand those steps to the person. For quick answers without watching, web_search/read_webpage are faster.
- Websites: build_website writes complete, polished, responsive sites (semantic HTML, modern CSS, a little JS for interactivity). Write every file in full. For edits, read_website_file first, then rewrite the changed files.
- Trading (trading_account, market_quote, prepare_trade): you are NOT a financial advisor. Give facts only (prices, balances, positions); never recommend what or when to buy or sell, never predict prices, and say so briefly if asked for advice. Only call prepare_trade when the person explicitly names what to buy or sell; repeat the ticket back (paper or LIVE, symbol, side, size, price) and remind them to tap "Confirm order". You can never send an order yourself.
- Files and folders: make_folder, download_file, move_file, copy_file, list_folder, open_folder work only inside the person's user folders. Nothing is deleted or overwritten, and programs/installers are never downloaded.
- Research: for anything current, factual and uncertain, or "look up / research / find out", call web_search, then read_webpage on the 2-4 most relevant results, then answer with a concise summary and list the sources as links.
- Email: summarize emails briefly (sender, subject, gist). Only draft_email when asked; it is never sent until the person taps Send.
- Social media: you cannot post directly. draft_social_post opens a pre-filled draft; the person presses Post.
- Shopping: find_products, check details with read_webpage, recommend 1-3 options with prices, and only call prepare_order when the person picks one. You never place or pay for orders; the person checks out themselves.
- Never invent tool results. If a tool returns an error, explain it plainly and suggest the fix.
Context: ${new Date().toString()}. Home city: ${s.homeCity || 'not set'}. Units: ${s.units}. The person is using ${local ? 'the main computer' : 'a phone or another device'}.`;
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
  // Requests relayed by a tunnel (cloudflared, ngrok) arrive from localhost but are remote.
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']) return false;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const clientIp = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function startServer({ store, port, host, notify }) {
  const s0 = store.get();
  port = port || s0.port || 7777;
  const events = new Set();
  const broadcast = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of events) res.write(line);
  };
  const browser = createBrowser(store.dataDir, store.get, text => broadcast('tool-step', { text }));
  const music = createMusic(store, browser);
  const piper = createPiper(store.dataDir, message => broadcast('voice-setup', { message }));
  const voskModels = createVoskModels(store.dataDir, message => broadcast('voice-setup', { message }));
  const tools = createTools({
    dataDir: store.dataDir, music, browser, trading: createTrading(store.get), broadcast, notify, getSettings: store.get, runRoutine,
    sitesUrl: () => `http://127.0.0.1:${currentPort}`,
  });

  // Scheduled routines run on their own: the AI does the job with its tools.
  async function runRoutine(instruction) {
    const s = store.get();
    const ctx = { settings: s, local: true, routine: true, actions: [] };
    return chat({
      settings: s,
      history: [{ role: 'user', content: `(Scheduled routine) ${instruction}` }],
      systemPrompt: systemPrompt(s, true) + '\nThis is an automatic scheduled routine; the person may not be watching. Carry out the instruction with your tools (for example text_me if it asks to text), then reply with a short summary of what you did.',
      toolDefs: tools.defs,
      runTool: (name, args) => tools.run(name, args, ctx),
    });
  }
  const fails = new Map();

  function auth(req, url) {
    if (isLocal(req)) return 'ok';
    const s = store.get();
    if (!s.remote.enabled || !s.remote.passcode) return 'off';
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.count >= 8 && Date.now() - f.at < 600_000) return 'locked';
    const given = String(req.headers['x-jarvis-pass'] || url.searchParams.get('pass') || '');
    const hash = v => crypto.createHash('sha256').update(v).digest();
    if (given && crypto.timingSafeEqual(hash(given), hash(s.remote.passcode))) { fails.delete(ip); return 'ok'; }
    if (given) fails.set(ip, { count: (f && Date.now() - f.at < 600_000 ? f.count : 0) + 1, at: Date.now() });
    return 'bad';
  }

  function send(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      // The speech model and engine are big and never change: let browsers keep them.
      const big = /^(models|vendor)[\\/]/.test(rel);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': big ? 'public, max-age=2592000, immutable' : 'no-cache' });
      res.end(data);
    });
  }

  let cpuPrev = cpuTimes();
  function cpuTimes() {
    return os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
  }

  async function handleApi(req, res, url, local) {
    const route = `${req.method} ${url.pathname}`;
    const json = async () => JSON.parse((await readBody(req, 2_000_000)).toString() || '{}');
    const ownerOnly = () => { if (!local) { send(res, 403, { error: 'Settings can only be changed on the main computer.' }); return true; } return false; };

    switch (route) {
      case 'GET /api/settings':
        return send(res, 200, { ...store.getPublic(), local, providerName: NAMES[store.get().provider], spotifyConnected: music.spotifyConnected(), emailPresets: Object.keys(email.PRESETS) });
      case 'POST /api/settings': {
        if (ownerOnly()) return;
        const before = store.get().remote.enabled;
        const out = store.update(await json());
        send(res, 200, out);
        if (out.remote.enabled !== before) setTimeout(rebind, 200);
        return;
      }
      case 'GET /api/email/detect':
        if (ownerOnly()) return;
        try { return send(res, 200, await email.detect(url.searchParams.get('address'))); } catch (e) { return send(res, 200, { error: e.message }); }
      case 'POST /api/email/connect': {
        // Easy email setup: test the app password, then save everything at once.
        if (ownerOnly()) return;
        const b = await json();
        let d;
        try { d = await email.detect(b.email); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
        if (d.guide?.oauthOnly) return send(res, 200, { ok: false, error: d.guide.note });
        const servers = b.servers?.imapHost ? b.servers : d; // "Advanced" overrides
        const password = String(b.password || '').trim().replace(d.preset === 'gmail' ? /\s+/g : /^$/, '');
        if (!password) return send(res, 200, { ok: false, error: 'Paste the app password first.' });
        try {
          const t = await email.testLogin({ email: d.email, password, ...servers });
          store.update({
            email: { preset: b.servers?.imapHost ? 'custom' : d.preset, user: d.email, imapHost: servers.imapHost, imapPort: Number(servers.imapPort) || 993, smtpHost: servers.smtpHost, smtpPort: Number(servers.smtpPort) || 465 },
            keys: { email: password },
          });
          return send(res, 200, { ok: true, canSend: t.canSend, email: d.email });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }
      case 'POST /api/email/disconnect':
        if (ownerOnly()) return;
        store.setSecret('email', '');
        store.update({ email: { user: '' } });
        return send(res, 200, { ok: true });
      case 'POST /api/keys/test': {
        // "Make it fast": check a pasted free key really works, then save it.
        if (ownerOnly()) return;
        const { provider, key } = await json();
        const k = String(key || '').trim();
        const TESTS = { groq: 'https://api.groq.com/openai/v1/models', cerebras: 'https://api.cerebras.ai/v1/models', mistral: 'https://api.mistral.ai/v1/models' };
        if (!TESTS[provider]) return send(res, 400, { error: 'Unknown service.' });
        if (k.length < 20 || /\s/.test(k)) return send(res, 200, { ok: false, error: "That doesn't look like a full key. Copy it again with the Copy button and paste it here." });
        try {
          const r = await fetch(TESTS[provider], { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
          if (r.status === 401 || r.status === 403) return send(res, 200, { ok: false, error: 'Groq says this key is not valid. Make sure you copied the whole key.' });
          if (!r.ok) return send(res, 200, { ok: false, error: `Groq answered with an error (${r.status}). Try again in a minute.` });
        } catch { return send(res, 200, { ok: false, error: "Couldn't reach Groq. Check the internet connection." }); }
        store.update({ keys: { [provider]: k } });
        return send(res, 200, { ok: true });
      }
      case 'POST /api/settings/clear-keys':
        if (ownerOnly()) return;
        music.disconnect();
        return send(res, 200, store.clearKeys());
      case 'GET /api/network':
        if (ownerOnly()) return;
        return send(res, 200, { port: currentPort, urls: store.get().remote.enabled ? lanUrls(currentPort) : [] });

      case 'POST /api/ask': {
        const { history, deviceCity, stream } = await json();
        const s = store.get();
        // A phone with its own location: weather etc. default to where that person is.
        if (typeof deviceCity === 'string' && deviceCity.trim()) s.homeCity = deviceCity.trim().slice(0, 80);
        const actions = [];
        const ctx = { settings: s, local, actions };
        // Only send the AI the tools this conversation needs: much faster replies.
        const toolDefs = tools.pick(history);
        // stream: text goes to the screen word by word (one JSON object per line).
        const write = obj => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n'); };
        if (stream) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        // "Stop": the app drops the connection, and everything still running here halts.
        const cancel = new AbortController();
        res.on('close', () => { if (!res.writableFinished) cancel.abort(); });
        try {
          const reply = await chat({
            signal: cancel.signal,
            settings: s, history, systemPrompt: systemPrompt(s, local), toolDefs,
            runTool: (name, args) => { broadcastTo(res, name); if (stream) write({ t: 'tool', name }); return tools.run(name, args, ctx); },
            onToken: stream ? text => write({ t: 'token', v: text }) : undefined,
          });
          const out = { reply: reply || `Done, ${s.userTitle}.`, actions };
          if (stream) { write({ t: 'done', ...out }); return res.end(); }
          return send(res, 200, out);
        } catch (e) {
          if (e.cancelled) { if (!res.writableEnded) res.end(); return; }
          if (stream) { write({ t: 'error', error: e.message, actions }); return res.end(); }
          return send(res, 200, { error: e.message, actions });
        }
      }
      case 'POST /api/tts': {
        const { text, preview } = await json();
        // preview = settings being tried in the Voice tab before saving (owner only).
        const s = store.get();
        if (preview && local) s.voice = { ...s.voice, ...preview };
        try { return send(res, 200, await voice.tts(text, s, piper)); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      case 'GET /api/ollama/status': {
        const base = (store.get().ollamaUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
        try {
          const d = await (await fetch(base + '/api/tags', { signal: AbortSignal.timeout(1500) })).json();
          const want = store.get().models.ollama || 'llama3.1';
          return send(res, 200, { running: true, ready: (d.models || []).some(m => m.name === want || m.name.startsWith(want + ':')), model: want });
        } catch { return send(res, 200, { running: false }); }
      }
      case 'POST /api/ollama/setup': {
        // Download the free, unlimited offline AI model into Ollama (Ollama itself is installed by the person).
        if (ownerOnly()) return;
        const base = (store.get().ollamaUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
        const model = store.get().models.ollama || 'llama3.1';
        let r;
        try { r = await fetch(base + '/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }) }); }
        catch { return send(res, 200, { needsInstall: true, url: 'https://ollama.com/download' }); }
        send(res, 200, { started: true, model });
        (async () => {
          let buf = '', last = 0;
          const dec = new TextDecoder();
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              try {
                const d = JSON.parse(line);
                const pct = d.total ? Math.round((d.completed || 0) / d.total * 100) : null;
                if (d.error) broadcast('ollama', { error: d.error });
                else if (d.status === 'success') broadcast('ollama', { done: true, model });
                else if (pct !== null && (pct - last >= 5 || pct === 100)) { last = pct; broadcast('ollama', { progress: pct }); }
              } catch {}
            }
          }
        })().catch(e => broadcast('ollama', { error: e.message }));
        return;
      }
      case 'GET /api/voices': return send(res, 200, { piper: piper.supported ? piper.voices() : [] });
      case 'GET /api/stt-model': {
        // Which offline speech model the app should use for commands (downloads it if needed).
        const lang = store.get().sttLanguage;
        try {
          const name = await voskModels.prepare(lang);
          return send(res, 200, { url: name ? `/extra-models/${name}.tar.gz` : null });
        } catch (e) { return send(res, 200, { url: null, error: e.message }); }
      }
      case 'POST /api/voice/prepare': {
        // Download the voice ahead of time so the first reply isn't slow.
        const s = store.get();
        if (s.voice.engine === 'piper' && piper.supported) piper.prepare(s.voice.piperVoice).then(() => broadcast('voice-setup', { message: 'ready' })).catch(e => broadcast('voice-setup', { message: 'failed: ' + e.message }));
        return send(res, 200, { ok: true });
      }
      case 'GET /api/stt-ready': return send(res, 200, voice.sttReady(store.get()));
      case 'POST /api/stt': {
        const buf = await readBody(req, 25_000_000);
        try { return send(res, 200, { text: await voice.transcribe(buf, req.headers['content-type'], store.get()) }); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      case 'POST /api/trade/confirm': {
        // The ONLY way an order reaches a broker: a person tapping Confirm on the main computer.
        if (ownerOnly()) return;
        const { id } = await json();
        try { return send(res, 200, await tools.confirmTrade(String(id || ''))); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      case 'POST /api/email/send': {
        const draft = await json();
        try { return send(res, 200, await email.sendEmail(store.get(), draft)); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      case 'GET /api/stats': {
        const now = cpuTimes();
        const di = now.idle - cpuPrev.idle, dt = now.total - cpuPrev.total;
        cpuPrev = now;
        return send(res, 200, { cpu: dt ? Math.round(100 * (1 - di / dt)) : 0, mem: Math.round(100 * (1 - os.freemem() / os.totalmem())), uptime: os.uptime(), host: os.hostname() });
      }
      case 'GET /api/weather': {
        // ?city= lets each device (e.g. a friend's phone) show its own location.
        const s = store.get();
        const city = (url.searchParams.get('city') || '').trim().slice(0, 80) || s.homeCity;
        if (!city) return send(res, 200, { error: 'no-city' });
        try { return send(res, 200, await tools.weather(city, s.units)); } catch (e) { return send(res, 200, { error: e.message }); }
      }
      case 'GET /api/locate': {
        // Rough city from the internet address (no GPS needed, works in the desktop app too).
        const ip = local ? '' : clientIp(req).replace(/^::ffff:/, '');
        const lookups = [
          async () => { const d = await research.getJSON(`https://ipapi.co/${ip ? ip + '/' : ''}json/`); if (d.error || !d.city) throw 0; return [d.city, d.region, d.country_name]; },
          async () => { const d = await research.getJSON(`https://ipwho.is/${ip}`); if (!d.success) throw 0; return [d.city, d.region, d.country]; },
        ];
        for (const look of lookups) {
          try { const parts = (await look()).filter(Boolean); return send(res, 200, { city: [...new Set(parts)].join(', ') }); } catch {}
        }
        return send(res, 200, { error: "Couldn't detect the location. Type your city instead." });
      }
      case 'GET /api/reminders': return send(res, 200, tools.reminders());
      case 'GET /api/tasks': return send(res, 200, tools.tasks());
      case 'POST /api/tasks/toggle': {
        const { id } = await json();
        return send(res, 200, tools.toggleTask(id));
      }
      case 'GET /api/news':
        try { return send(res, 200, await research.news()); } catch (e) { return send(res, 200, { headlines: [], error: e.message }); }
      case 'GET /api/events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        events.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); events.delete(res); });
        return;
      }
      case 'GET /api/spotify/login':
        if (ownerOnly()) return;
        try { res.writeHead(302, { location: music.loginUrl(currentPort) }); return res.end(); } catch (e) { return send(res, 400, { error: e.message }); }
      case 'GET /api/apple/status':
        try { return send(res, 200, await music.appleStatus()); } catch (e) { return send(res, 200, { error: e.message }); }
      case 'POST /api/apple/connect': {
        // Opens Apple Music in Jarvis's browser; the person signs in there themselves.
        // We watch for Apple's sign-in cookie for up to 10 minutes.
        if (ownerOnly()) return;
        try { await browser.appleMusicSignIn(); } catch (e) { return send(res, 200, { error: e.message }); }
        send(res, 200, { ok: true });
        const started = Date.now();
        const timer = setInterval(async () => {
          const ok = await browser.appleMusicSignedIn().catch(() => null);
          if (ok) {
            clearInterval(timer);
            store.update({ music: { appleWeb: true } });
            broadcast('apple', { connected: true });
          } else if (ok === null || Date.now() - started > 10 * 60000) clearInterval(timer);
        }, 3000);
        return;
      }
      case 'POST /api/apple/disconnect':
        if (ownerOnly()) return;
        store.update({ music: { appleWeb: false } });
        return send(res, 200, { ok: true });
      case 'POST /api/spotify/disconnect':
        if (ownerOnly()) return;
        music.disconnect();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'Unknown API route' });
    }
  }

  // Tool activity ("Searching the web...") goes to every open screen.
  function broadcastTo(_res, name) { broadcast('tool', { name }); }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      // Spotify sends the browser back here after login (on the main computer).
      if (url.pathname === '/api/spotify/callback') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        try {
          if (!isLocal(req)) throw new Error('Connect Spotify from the main computer.');
          if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
          await music.finishLogin(url.searchParams.get('code'), url.searchParams.get('state'));
          broadcast('spotify', { connected: true });
          return res.end('<body style="background:#03070c;color:#5fe3ff;font:20px sans-serif;text-align:center;padding-top:20vh">Spotify connected. You can close this tab and go back to Jarvis.</body>');
        } catch (e) {
          return res.end(`<body style="background:#03070c;color:#ff8a65;font:20px sans-serif;text-align:center;padding-top:20vh">Spotify login failed: ${String(e.message).replace(/[<>&]/g, '')}</body>`);
        }
      }
      // Downloaded offline speech models live in the data folder, not in public/.
      if (url.pathname.startsWith('/extra-models/')) {
        const f = voskModels.file(url.pathname.slice('/extra-models/'.length));
        if (!f) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=2592000, immutable' });
        return fs.createReadStream(f).pipe(res);
      }
      // Websites Jarvis built, previewed on the main computer only.
      if (url.pathname.startsWith('/sites/')) {
        if (!isLocal(req)) return send(res, 403, { error: 'Website previews open on the main computer.' });
        const root = tools.sitesDir();
        let rel = decodeURIComponent(url.pathname.slice('/sites/'.length));
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        const file = path.normalize(path.join(root, rel));
        if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'Forbidden' });
        return fs.readFile(file, (err, data) => {
          if (err) return send(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(data);
        });
      }
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      const local = isLocal(req);
      if (url.pathname === '/api/hello') return send(res, 200, { local, status: auth(req, url) });
      const a = auth(req, url);
      if (a === 'locked') return send(res, 429, { error: 'Too many wrong passcodes. Try again in 10 minutes.' });
      if (a === 'off') return send(res, 403, { error: 'Remote access is turned off. Turn it on in Settings on the main computer.' });
      if (a !== 'ok') return send(res, 401, { error: 'Passcode required.' });
      await handleApi(req, res, url, local);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  }

  let server;
  let currentPort = port;
  const listenHost = () => host || (store.get().remote.enabled ? '0.0.0.0' : '127.0.0.1');

  function listen(p) {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.once('error', reject);
      server.listen(p, listenHost(), () => { currentPort = p; resolve(p); });
    });
  }

  async function rebind() {
    await new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); });
    await listen(currentPort);
  }

  // If the port is busy, try the next few.
  for (let i = 0; ; i++) {
    try { await listen(port + i); break; } catch (e) { if (e.code !== 'EADDRINUSE' || i >= 10) throw e; }
  }

  return {
    get port() { return currentPort; },
    lanUrls: () => lanUrls(currentPort),
  };
}

module.exports = { startServer };
