// Everything Jarvis can *do*. Each tool has a definition (shown to the AI) and
// an implementation. Things that must happen on the person's own device
// (opening a link, copying text, reviewing an email before sending) come back
// as "actions" the app carries out, so they work on phones too.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const research = require('./research');
const email = require('./email');
const phone = require('./phone');

const enc = encodeURIComponent;

const SOCIAL = {
  x: { home: 'https://x.com', share: t => `https://x.com/intent/tweet?text=${enc(t)}` },
  facebook: { home: 'https://www.facebook.com' },
  instagram: { home: 'https://www.instagram.com' },
  tiktok: { home: 'https://www.tiktok.com' },
  youtube: { home: 'https://www.youtube.com' },
  linkedin: { home: 'https://www.linkedin.com/feed/', share: t => `https://www.linkedin.com/feed/?shareActive=true&text=${enc(t)}` },
  reddit: { home: 'https://www.reddit.com', share: t => `https://www.reddit.com/submit?title=${enc(t)}` },
  threads: { home: 'https://www.threads.net', share: t => `https://www.threads.net/intent/post?text=${enc(t)}` },
  bluesky: { home: 'https://bsky.app', share: t => `https://bsky.app/intent/compose?text=${enc(t)}` },
  whatsapp: { home: 'https://web.whatsapp.com', share: t => `https://wa.me/?text=${enc(t)}` },
  telegram: { home: 'https://web.telegram.org', share: t => `https://t.me/share/url?url=&text=${enc(t)}` },
  discord: { home: 'https://discord.com/app' },
  snapchat: { home: 'https://web.snapchat.com' },
  pinterest: { home: 'https://www.pinterest.com' },
  twitch: { home: 'https://www.twitch.tv' },
};
const SOCIAL_ALIASES = { twitter: 'x', 'x.com': 'x', ig: 'instagram', insta: 'instagram', fb: 'facebook', yt: 'youtube', wa: 'whatsapp', bsky: 'bluesky', snap: 'snapchat' };
const socialKey = p => { const k = String(p || '').toLowerCase().trim(); return SOCIAL[k] ? k : SOCIAL_ALIASES[k]; };

const STORES = {
  amazon: { domain: 'amazon.com', search: q => `https://www.amazon.com/s?k=${enc(q)}` },
  ebay: { domain: 'ebay.com', search: q => `https://www.ebay.com/sch/i.html?_nkw=${enc(q)}` },
  walmart: { domain: 'walmart.com', search: q => `https://www.walmart.com/search?q=${enc(q)}` },
  target: { domain: 'target.com', search: q => `https://www.target.com/s?searchTerm=${enc(q)}` },
  bestbuy: { domain: 'bestbuy.com', search: q => `https://www.bestbuy.com/site/searchpage.jsp?st=${enc(q)}` },
};

const US_STATES = Object.fromEntries(Object.entries({
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', pr: 'puerto rico', dc: 'district of columbia',
}).map(([k, v]) => [k, v]));

const WEATHER = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

const fn = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, required } });
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });

const DEFS = [
  fn('get_datetime', 'Current local date, time and day of week.'),
  fn('get_weather', 'Current weather and 3-day forecast. Uses the home city if no location is given.', { location: str('City, e.g. "Austin, Texas" or "London"') }),
  fn('web_search', 'Search the internet. Use for research, current events, prices, scores, facts you are unsure of. Then use read_webpage on the best results.', { query: str('Search query'), max_results: num('1-10, default 6') }, ['query']),
  fn('read_webpage', 'Fetch a web page and return its readable text, to research a topic in depth.', { url: str('Full http(s) URL') }, ['url']),
  fn('get_news', 'Latest news headlines, optionally about a topic.', { topic: str('Optional topic, e.g. "AI", "Lakers", "stock market"') }),
  fn('open_website', "Open a web page on the person's device.", { url: str('Full URL'), label: str('Short name for the button') }, ['url']),
  fn('open_social', "Open a social media site on the person's device.", { platform: str('x, instagram, facebook, tiktok, youtube, linkedin, reddit, threads, bluesky, whatsapp, telegram, discord, snapchat, pinterest, twitch') }, ['platform']),
  fn('draft_social_post', 'Write a social media post and open it pre-filled so the person can review and press Post themselves. Also copies the text.', { platform: str('Platform name'), text: str('Post text') }, ['platform', 'text']),
  fn('check_email', "List recent emails from the person's inbox (unread by default).", { unread_only: { type: 'boolean' }, limit: num('Max emails, default 10'), folder: str('Mailbox folder, default INBOX') }),
  fn('search_email', 'Search the mailbox. On Gmail you can use Gmail syntax like "from:amazon newer_than:7d".', { query: str('Words, a name or an address'), limit: num('Max results') }, ['query']),
  fn('read_email', 'Read the full text of one email by its id (from check_email or search_email).', { id: num('Email id') }, ['id']),
  fn('draft_email', 'Prepare an email or reply. It is NOT sent: the person reviews it and taps Send in the app.', { to: str('Recipient address(es), comma separated'), cc: str('Optional CC'), subject: str('Subject'), body: str('Plain-text body, signed with the person\'s name if known'), reply_to_id: num('If replying, the id of the email being answered') }, ['to', 'subject', 'body']),
  fn('music', 'Play and control music on Spotify or Apple Music.', {
    action: { type: 'string', enum: ['play', 'pause', 'resume', 'next', 'previous', 'volume', 'now_playing'] },
    query: str('Song, artist, album or playlist to play'),
    kind: { type: 'string', enum: ['track', 'artist', 'album', 'playlist'], description: 'What the query is, default track' },
    service: { type: 'string', enum: ['spotify', 'apple_music'], description: "Omit to use the person's default" },
    volume: num('0-100 for the volume action'),
  }, ['action']),
  fn('find_products', 'Shopping: search a store (or several) for products and compare options/prices. Then summarize the best picks.', {
    query: str('What to buy, with any budget/size/brand details'),
    store: { type: 'string', enum: ['amazon', 'ebay', 'walmart', 'target', 'bestbuy', 'any'], description: 'Default any' },
  }, ['query']),
  fn('prepare_order', "Get an order ready: for Amazon, adds the product to the person's Amazon cart; for other stores, opens the product page. Jarvis never pays: the person reviews and places the order themselves.", {
    store: { type: 'string', enum: ['amazon', 'ebay', 'walmart', 'target', 'bestbuy', 'other'] },
    product_url: str('Product page URL (from find_products)'),
    quantity: num('Default 1'),
  }, ['store', 'product_url']),
  fn('trading_account', 'Show a connected brokerage account: balance, buying power, positions and open orders. Alpaca = US stocks and crypto, OANDA = forex.', { broker: { type: 'string', enum: ['alpaca', 'oanda'] } }, ['broker']),
  fn('market_quote', 'Latest bid/ask price for a stock (AAPL), crypto (BTC/USD) via alpaca, or a forex pair (EUR/USD) via oanda.', { broker: { type: 'string', enum: ['alpaca', 'oanda'] }, symbol: str('Ticker, crypto pair or currency pair') }, ['broker', 'symbol']),
  fn('prepare_trade', 'Prepare an order ticket ONLY when the person explicitly asks to buy/sell something specific. It is NOT sent: the person must tap "Confirm order" on the main computer. Never suggest what to trade.', {
    broker: { type: 'string', enum: ['alpaca', 'oanda'] }, symbol: str('e.g. AAPL, TSLA, BTC/USD, EUR/USD'),
    side: { type: 'string', enum: ['buy', 'sell'] }, quantity: num('Shares / coins / forex units'), amount_usd: num('Dollar amount instead of quantity (Alpaca only)'),
    order_type: { type: 'string', enum: ['market', 'limit'] }, limit_price: num('For limit orders'),
    stop_loss: num('Optional stop-loss price'), take_profit: num('Optional take-profit price'),
  }, ['broker', 'symbol', 'side']),
  fn('text_me', "Send a text message (SMS) to the owner's own phone.", { message: str('Text to send') }, ['message']),
  fn('call_me', "Phone the owner's own phone and read a message aloud. For wake-up calls or urgent alerts, combine with set_reminder deliver=call.", { message: str('What to say') }, ['message']),
  fn('set_reminder', "Set a reminder after some minutes. It pops up in the app and is spoken; it can also text or call the owner's phone.", {
    message: str('What to remind about'), minutes: num('Minutes from now (can be fractional)'),
    deliver: { type: 'string', enum: ['app', 'text', 'call'], description: 'Default app' },
  }, ['message', 'minutes']),
  fn('list_reminders', 'List upcoming reminders.'),
  fn('cancel_reminder', 'Cancel a reminder by id.', { id: num('Reminder id') }, ['id']),
  fn('add_task', "Add an item to the person's to-do list.", { text: str('The task'), due: str('Optional due date/time in plain words, e.g. "Friday 5pm"') }, ['text']),
  fn('list_tasks', 'Show the to-do list.', { include_done: { type: 'boolean' } }),
  fn('complete_task', 'Mark a to-do item done by id.', { id: num('Task id') }, ['id']),
  fn('delete_task', 'Remove a to-do item by id.', { id: num('Task id') }, ['id']),
  fn('schedule_routine', 'Schedule something Jarvis will do automatically at a time, once or on repeat, e.g. "every weekday at 8:00 text me the weather and my unread emails". The instruction is carried out by the AI with all its tools at that time.', {
    instruction: str('What to do, written as a request to the assistant'),
    time: str('24-hour time HH:MM, e.g. "08:00"'),
    repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly'], description: 'Default daily' },
    weekday: str('For weekly: monday..sunday. For once: optional date YYYY-MM-DD'),
  }, ['instruction', 'time']),
  fn('list_routines', 'List scheduled routines.'),
  fn('delete_routine', 'Delete a scheduled routine by id.', { id: num('Routine id') }, ['id']),
  fn('create_file', 'Create a document/file (letter, list, plan, notes, CSV, code...) in the Jarvis folder inside Documents on the main computer.', {
    filename: str('File name with extension: .txt .md .csv .html .json'), content: str('Full file content'),
  }, ['filename', 'content']),
  fn('list_files', 'List files in the Jarvis folder in Documents.'),
  fn('make_folder', "Create a folder in the person's user folders, e.g. \"Documents/Taxes 2026\" or \"Desktop/School/Math\".", { path: str('Folder path starting from Documents, Desktop, Downloads, Pictures, Music or Videos') }, ['path']),
  fn('download_file', 'Download a file from the internet (PDF, image, document, audio, video, zip…) into a folder. Programs/installers/scripts are refused for safety.', {
    url: str('Direct http(s) link to the file'), folder: str('Destination folder, e.g. "Documents/Recipes" (created if missing)'), filename: str('Optional file name to save as'),
  }, ['url', 'folder']),
  fn('move_file', "Move a file or folder within the person's user folders (never overwrites).", { from: str('Current path, e.g. "Downloads/report.pdf"'), to: str('Destination folder or full new path') }, ['from', 'to']),
  fn('copy_file', "Copy a file within the person's user folders (never overwrites).", { from: str('Source path'), to: str('Destination folder or full new path') }, ['from', 'to']),
  fn('list_folder', "List what's inside one of the person's folders.", { path: str('e.g. "Downloads" or "Documents/Taxes 2026"') }, ['path']),
  fn('open_folder', 'Open a folder on screen in File Explorer / Finder.', { path: str('Folder path') }, ['path']),
  fn('browser_search', 'LIVE BROWSER on the main computer: opens a real, visible browser window and searches Google so the person can watch. Use when they ask you to research "on my computer", "show me", "open the browser", or when a site needs real browsing. Returns result links.', { query: str('Search words') }, ['query']),
  fn('browser_open', 'LIVE BROWSER: open a URL in the visible browser window and return the page text and links.', { url: str('Full URL') }, ['url']),
  fn('browser_click', 'LIVE BROWSER: click a link or button by its visible text (or give a URL from the page).', { target: str('Visible text of the link/button, or a URL') }, ['target']),
  fn('browser_type', 'LIVE BROWSER: type into a search box or text field (never passwords or payment details).', { field: str('Placeholder or label of the box; empty = the first text box'), text: str('Text to type'), submit: { type: 'boolean', description: 'Press Enter afterwards' } }, ['text']),
  fn('browser_scroll', 'LIVE BROWSER: scroll the page.', { direction: { type: 'string', enum: ['down', 'up'] } }),
  fn('browser_back', 'LIVE BROWSER: go back one page.'),
  fn('browser_read', 'LIVE BROWSER: read the current page in full.'),
  fn('browser_close', 'LIVE BROWSER: close the browser window when finished (only if the person is done watching).'),
  fn('build_website', 'Create or update a website on the main computer: write ALL files in full (at least index.html; modern, responsive, good-looking HTML/CSS/JS; no external build tools). Saved in Documents\\Jarvis\\Websites\\<name> and opened in the live browser to show the person. For changes, pass the complete new content of each changed file.', {
    name: str('Short folder name for the site, e.g. "santi-friends"'),
    files: { type: 'array', description: 'Files to write', items: { type: 'object', properties: { path: str('e.g. index.html, style.css, about.html, js/app.js'), content: str('Full file content') }, required: ['path', 'content'] } },
  }, ['name', 'files']),
  fn('read_website_file', 'Read a file of a website you built earlier (to edit it).', { name: str('Site folder name'), path: str('File path, default index.html') }, ['name']),
  fn('list_websites', 'List the websites built so far and their files.'),
  fn('save_note', 'Save a note for later.', { text: str('The note') }, ['text']),
  fn('get_notes', 'Read all saved notes.'),
  fn('delete_note', 'Delete a saved note by id.', { id: num('Note id') }, ['id']),
  fn('copy_to_clipboard', "Copy text to the person's clipboard.", { text: str('Text to copy') }, ['text']),
  fn('open_app', 'Open an app on the main computer (not phones), e.g. calculator, notepad, chrome, spotify, word.', { name: str('App name') }, ['name']),
  fn('system_status', 'CPU, memory, uptime and OS of the main computer.'),
];

// Which tools a request needs, guessed from the recent messages. Fewer tools =
// a much smaller request = faster (and more accurate) answers, especially on free AIs.
const CORE_TOOLS = ['get_datetime', 'get_weather', 'web_search', 'read_webpage', 'get_news', 'open_website', 'save_note', 'get_notes',
  'set_reminder', 'list_reminders', 'add_task', 'list_tasks', 'complete_task', 'copy_to_clipboard'];
const TOOL_GROUPS = [
  [/e-?mail|inbox|gmail|outlook|yahoo mail|unread|reply|draft|message from/i, ['check_email', 'search_email', 'read_email', 'draft_email']],
  [/play|song|music|spotify|apple music|pause|resume|skip|next track|previous|volume|playing|album|playlist|artist|tune/i, ['music']],
  [/post|tweet|instagram|facebook|tiktok|linkedin|reddit|threads|bluesky|whatsapp|telegram|discord|snapchat|pinterest|twitch|youtube|social|caption/i, ['open_social', 'draft_social_post']],
  [/buy|order|shop|amazon|ebay|walmart|target|best ?buy|cheap|deal|product|cart|purchase/i, ['find_products', 'prepare_order']],
  [/stock|shares?\b|crypto|bitcoin|btc|eth|forex|trade|trading|alpaca|oanda|portfolio|position|ticker|eur\/?usd|market/i, ['trading_account', 'market_quote', 'prepare_trade']],
  [/text me|call me|sms|phone|wake me|wake-?up/i, ['text_me', 'call_me']],
  [/browser|show me|on (my|the) (computer|screen|pc)|chrome|edge|brave|watch|navigate|click|scroll|go back|look (it )?up on/i, ['browser_search', 'browser_open', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_read', 'browser_close']],
  [/website|web ?site|landing page|web ?page|homepage|html|css/i, ['build_website', 'read_website_file', 'list_websites', 'browser_open']],
  [/folder|file|download|move|copy|desktop|documents|downloads|pictures|videos|save (it|this|that)/i, ['make_folder', 'download_file', 'move_file', 'copy_file', 'list_folder', 'open_folder', 'create_file', 'list_files']],
  [/open |launch|start (the )?app|calculator|notepad|settings app/i, ['open_app']],
  [/every (day|morning|night|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|routine|schedule|each (morning|day|night)|daily|weekly|weekdays?/i, ['schedule_routine', 'list_routines', 'delete_routine']],
  [/cancel|delete|remove|clear|undo/i, ['cancel_reminder', 'delete_task', 'delete_note', 'delete_routine']],
  [/system|cpu|memory|ram|computer status|diagnostic/i, ['system_status']],
];

function pickTools(history) {
  const recent = (Array.isArray(history) ? history : []).slice(-6).map(m => String(m.content || '')).join('\n');
  const names = new Set(CORE_TOOLS);
  for (const [re, list] of TOOL_GROUPS) if (re.test(recent)) list.forEach(n => names.add(n));
  return DEFS.filter(d => names.has(d.name));
}

function createTools({ dataDir, music, browser, trading, sitesUrl, broadcast, notify, getSettings, runRoutine }) {
  const file = name => path.join(dataDir, name);
  const readJSON = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
  const writeJSON = (name, data) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file(name), JSON.stringify(data, null, 2)); };

  // ---------- reminders (saved to disk, so they survive a restart) ----------
  let reminders = readJSON('reminders.json', []);
  const timers = new Map();
  const publicReminders = () => reminders.map(({ id, message, due, deliver }) => ({ id, message, due, deliver }));
  const saveReminders = () => { writeJSON('reminders.json', reminders); broadcast('reminders', publicReminders()); };

  function schedule(r) {
    const fire = () => {
      timers.delete(r.id);
      reminders = reminders.filter(x => x.id !== r.id);
      saveReminders();
      const s = getSettings();
      const me = s.assistantName || 'Jarvis';
      notify?.(`${me} reminder`, r.message);
      broadcast('reminder', { id: r.id, message: r.message });
      if (r.deliver === 'text') phone.textMe(s, `${me} reminder: ${r.message}`).catch(e => broadcast('reminder-error', { message: e.message }));
      if (r.deliver === 'call') phone.callMe(s, `Good day, ${s.userName || s.userTitle || 'sir'}. This is ${me} with your reminder. ${r.message}`).catch(e => broadcast('reminder-error', { message: e.message }));
    };
    const wait = r.due - Date.now();
    if (wait <= 0) return setTimeout(fire, 3000); // missed while closed: fire shortly after start
    // setTimeout can't wait more than ~24 days; re-check daily.
    timers.set(r.id, setTimeout(() => (Date.now() >= r.due ? fire() : schedule(r)), Math.min(wait, 86_400_000)));
  }
  reminders.forEach(schedule);

  // ---------- to-do list ----------
  let tasks = readJSON('tasks.json', []);
  const saveTasks = () => { writeJSON('tasks.json', tasks); broadcast('tasks', tasks); };
  function toggleTask(id) {
    const t = tasks.find(x => x.id === Number(id));
    if (t) { t.done = !t.done; saveTasks(); }
    return tasks;
  }

  // ---------- scheduled routines ----------
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let routines = readJSON('routines.json', []);
  const saveRoutines = () => writeJSON('routines.json', routines);

  // Next time a routine should run, after `from`.
  function nextRun(r, from = Date.now()) {
    const [hh, mm] = r.time.split(':').map(Number);
    if (r.repeat === 'once' && /^\d{4}-\d{2}-\d{2}$/.test(r.weekday || '')) {
      const d = new Date(`${r.weekday}T${r.time}:00`);
      return d.getTime() > from ? d.getTime() : null;
    }
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setHours(hh, mm);
    for (let i = 0; i < 8; i++) {
      const ok = d.getTime() > from && (
        r.repeat === 'weekdays' ? d.getDay() >= 1 && d.getDay() <= 5
          : r.repeat === 'weekly' ? DAYS[d.getDay()] === String(r.weekday || '').toLowerCase()
            : true);
      if (ok) return d.getTime();
      d.setDate(d.getDate() + 1);
      d.setHours(hh, mm);
    }
    return null;
  }

  // Repeating routines missed while Jarvis was closed just move to their next time.
  routines = routines.map(r => (r.repeat !== 'once' && r.next && r.next < Date.now() ? { ...r, next: nextRun(r) } : r));

  async function fireRoutine(r) {
    const me = getSettings().assistantName || 'Jarvis';
    let reply;
    try { reply = await runRoutine(r.instruction); } catch (e) { reply = `Routine failed: ${e.message}`; }
    broadcast('routine', { id: r.id, instruction: r.instruction, reply });
    notify?.(`${me} routine`, reply.slice(0, 200));
  }

  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const r of [...routines]) {
      if (r.next && r.next <= now) {
        fireRoutine(r);
        r.next = r.repeat === 'once' ? null : nextRun(r, now + 60_000);
        changed = true;
      }
    }
    const before = routines.length;
    routines = routines.filter(r => r.next);
    if (changed || routines.length !== before) saveRoutines();
  }, 20_000);

  // ---------- files ----------
  const filesDir = () => path.join(os.homedir(), 'Documents', 'Jarvis');
  const sitesDir = () => path.join(filesDir(), 'Websites');
  const siteName = n => String(n || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // Folder/file help is limited to the person's own user folders. Hidden and
  // app-data folders are off limits, and nothing is ever deleted or overwritten.
  const USER_ROOTS = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Music', 'Videos', 'Movies'];
  function userPath(p) {
    const home = os.homedir();
    let s = String(p || '').trim().replace(/^~[\\/]?/, '').replace(/\\/g, '/');
    if (path.isAbsolute(s)) s = path.relative(home, s).replace(/\\/g, '/');
    const parts = s.split('/').filter(Boolean);
    const root = USER_ROOTS.find(r => r.toLowerCase() === (parts[0] || '').toLowerCase());
    if (!root || parts.some(x => x === '..' || x.startsWith('.')) || parts.some(x => /[<>:"|?*]/.test(x))) return null;
    // OneDrive often moves Documents/Desktop/Pictures; use those if that's where they live.
    const od = process.env.OneDrive && path.join(process.env.OneDrive, root);
    const base = od && fs.existsSync(od) && !fs.existsSync(path.join(home, root)) ? od : path.join(home, root);
    return path.join(base, ...parts.slice(1));
  }
  const freeName = target => {
    let t = target;
    for (let n = 2; fs.existsSync(t); n++) t = target.replace(/(\.[^.\\/]+)?$/, m => ` (${n})${m}`);
    return t;
  };
  const BLOCKED_EXT = /\.(exe|msi|msix|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|scr|pif|jar|dll|reg|lnk|dmg|pkg|app|sh|command|apk|iso)$/i;

  // Keep site files inside the site folder and to web file types.
  function sitePath(site, rel) {
    const clean = String(rel || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.split('/').includes('..') || !/\.(html?|css|js|json|svg|txt|md|webmanifest)$/i.test(clean)) return null;
    return path.join(sitesDir(), site, ...clean.split('/'));
  }

  // ---------- helpers ----------
  async function weather(location, units) {
    if (!location) return { error: 'No location given and no home city set. Ask the person which city.' };
    // Accept "Austin, Texas", "Austin Texas", "Brooksville FL", "Paris France"…
    const raw = String(location).trim();
    const tries = [];
    if (raw.includes(',')) {
      const [n, ...rest] = raw.split(',').map(x => x.trim());
      tries.push([n, rest.join(' ')]);
    } else {
      const words = raw.split(/\s+/);
      for (let cut = words.length; cut >= 1; cut--) tries.push([words.slice(0, cut).join(' '), words.slice(cut).join(' ')]);
    }
    let list = [], hint = '';
    for (const [n, h] of tries) {
      const geo = await research.getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc(n)}&count=10&language=en`);
      if (geo.results?.length) { list = geo.results; hint = h.toLowerCase(); break; }
    }
    if (!list.length) return { error: `I couldn't find a place called "${location}". Try "City, State" or "City, Country".` };
    hint = US_STATES[hint] || hint;
    const place = (hint && list.find(r => [r.admin1, r.country, r.country_code].filter(Boolean).some(v => v.toLowerCase().includes(hint) || hint.includes(v.toLowerCase())))) || list[0];
    const imp = units !== 'metric';
    const w = await research.getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3' +
      (imp ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''));
    const tu = imp ? '°F' : '°C';
    const c = w.current;
    return {
      place: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      now: {
        temperature: `${Math.round(c.temperature_2m)}${tu}`, feels_like: `${Math.round(c.apparent_temperature)}${tu}`,
        conditions: WEATHER[c.weather_code] || 'unknown', humidity: `${c.relative_humidity_2m}%`,
        wind: `${Math.round(c.wind_speed_10m)} ${imp ? 'mph' : 'km/h'}`,
      },
      forecast: w.daily.time.map((d, i) => ({
        date: d, conditions: WEATHER[w.daily.weather_code[i]] || 'unknown',
        high: `${Math.round(w.daily.temperature_2m_max[i])}${tu}`, low: `${Math.round(w.daily.temperature_2m_min[i])}${tu}`,
        rain_chance: `${w.daily.precipitation_probability_max[i] ?? 0}%`,
      })),
      code: c.weather_code, temp: Math.round(c.temperature_2m), unit: tu,
    };
  }

  const APPS_WIN = { calculator: 'calc', notepad: 'notepad', paint: 'mspaint', 'file explorer': 'explorer', explorer: 'explorer', files: 'explorer', 'command prompt': 'cmd', terminal: 'wt', settings: 'ms-settings:', chrome: 'chrome', 'google chrome': 'chrome', edge: 'msedge', word: 'winword', excel: 'excel', powerpoint: 'powerpnt', outlook: 'outlook', spotify: 'spotify:', 'apple music': 'music:', camera: 'microsoft.windows.camera:', calendar: 'outlookcal:', mail: 'outlookmail:' };
  const APPS_MAC = { calculator: 'Calculator', notepad: 'TextEdit', notes: 'Notes', terminal: 'Terminal', settings: 'System Settings', finder: 'Finder', files: 'Finder', 'file explorer': 'Finder', chrome: 'Google Chrome', 'google chrome': 'Google Chrome', safari: 'Safari', word: 'Microsoft Word', excel: 'Microsoft Excel', spotify: 'Spotify', 'apple music': 'Music', music: 'Music', mail: 'Mail', calendar: 'Calendar', messages: 'Messages', facetime: 'FaceTime' };

  function openApp(name) {
    const key = String(name || '').toLowerCase().trim();
    const target = (process.platform === 'darwin' ? APPS_MAC : APPS_WIN)[key] || String(name || '').trim();
    if (!/^[\w .:+\-]{1,60}$/.test(target)) return Promise.resolve({ error: 'That app name has characters I won\'t run.' });
    return new Promise(resolve => {
      const done = err => resolve(err ? { error: `Couldn't open "${name}".` } : { ok: true, opened: name });
      if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '""', `"${target}"`], { windowsVerbatimArguments: true, windowsHide: true }, done);
      else if (process.platform === 'darwin') execFile('open', ['-a', target], done);
      else execFile('xdg-open', [target], done);
    });
  }

  function systemStatus() {
    return {
      os: `${os.type()} ${os.release()}`, host: os.hostname(), cpu: os.cpus()[0]?.model, cores: os.cpus().length,
      memory_used: `${Math.round(100 * (1 - os.freemem() / os.totalmem()))}% of ${(os.totalmem() / 1073741824).toFixed(1)} GB`,
      uptime_hours: +(os.uptime() / 3600).toFixed(1),
    };
  }

  // ---------- run a tool ----------
  // ctx = { settings, local, actions } - actions are carried out by the app.
  async function run(name, args, ctx) {
    const s = ctx.settings;
    const act = a => ctx.actions.push(a);
    try {
      let result;
      switch (name) {
        case 'get_datetime': {
          const d = new Date();
          result = { date: d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), time: d.toLocaleTimeString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
          break;
        }
        case 'get_weather': result = await weather(args.location || s.homeCity, s.units); delete result.code; delete result.temp; delete result.unit; break;
        case 'web_search': result = await research.webSearch(args.query, s, args.max_results); break;
        case 'read_webpage': result = await research.readWebpage(args.url); break;
        case 'get_news': result = await research.news(args.topic); break;
        case 'open_website': {
          const u = new URL(/^https?:\/\//i.test(args.url) ? args.url : 'https://' + args.url);
          if (!/^https?:$/.test(u.protocol)) return { error: 'Only web links can be opened.' };
          act({ type: 'open', url: u.href, label: args.label || u.hostname });
          result = { ok: true, opened: u.href };
          break;
        }
        case 'open_social': {
          const k = socialKey(args.platform);
          if (!k) return { error: `I don't know "${args.platform}". Known: ${Object.keys(SOCIAL).join(', ')}` };
          act({ type: 'open', url: SOCIAL[k].home, label: `Open ${k}` });
          result = { ok: true };
          break;
        }
        case 'draft_social_post': {
          const k = socialKey(args.platform);
          if (!k) return { error: `I don't know "${args.platform}".` };
          act({ type: 'copy', text: args.text });
          const url = SOCIAL[k].share ? SOCIAL[k].share(args.text) : SOCIAL[k].home;
          act({ type: 'open', url, label: `Review ${k} post` });
          result = { ok: true, note: SOCIAL[k].share ? 'Opened a pre-filled draft; the person presses Post.' : `${k} has no pre-fill link, so the text was copied. The person pastes it in.` };
          break;
        }
        case 'check_email': result = await email.listEmails(s, args); break;
        case 'search_email': result = await email.searchEmails(s, args); break;
        case 'read_email': result = await email.readEmail(s, args); break;
        case 'draft_email': {
          let inReplyTo;
          if (args.reply_to_id) inReplyTo = (await email.readEmail(s, { id: args.reply_to_id }).catch(() => ({}))).message_id;
          act({ type: 'email', draft: { to: args.to, cc: args.cc || '', subject: args.subject, body: args.body, inReplyTo } });
          result = { ok: true, status: 'Draft shown to the person. It is sent only if they tap Send.' };
          break;
        }
        case 'music': result = await music.control(args, ctx); break;
        case 'find_products': {
          const store = STORES[args.store] ? args.store : 'any';
          const sites = store === 'any' ? ['amazon', 'ebay', 'walmart'] : [store];
          const found = [];
          for (const k of sites) {
            const r = await research.webSearch(`${args.query} site:${STORES[k].domain}`, s, store === 'any' ? 4 : 8).catch(() => ({ results: [] }));
            for (const x of r.results || []) if (x.url.includes(STORES[k].domain)) found.push({ store: k, ...x });
          }
          const first = sites[0];
          act({ type: 'open', url: STORES[first].search(args.query), label: `Search ${first}` });
          result = { results: found.slice(0, 12), note: 'Snippets may not show live prices; use read_webpage on a product URL to check price, rating and shipping before recommending.' };
          break;
        }
        case 'prepare_order': {
          const qty = Math.min(Math.max(Math.round(Number(args.quantity) || 1), 1), 99);
          const url = new URL(args.product_url);
          if (!/^https?:$/.test(url.protocol)) return { error: 'That is not a product link.' };
          if (args.store === 'amazon') {
            const asin = (url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1];
            if (!asin) return { error: 'I need an Amazon product page link (one with /dp/ in it).' };
            act({ type: 'open', url: `https://${url.hostname}/gp/aws/cart/add.html?ASIN.1=${asin.toUpperCase()}&Quantity.1=${qty}`, label: 'Review Amazon cart' });
            result = { ok: true, status: `Amazon add-to-cart page opened for ${qty}. The person confirms, then checks out themselves.` };
          } else {
            act({ type: 'open', url: url.href, label: `Open on ${args.store}` });
            result = { ok: true, status: `Product page opened. The person picks quantity ${qty} and taps Buy themselves.` };
          }
          break;
        }
        case 'set_reminder': {
          const minutes = Number(args.minutes);
          if (!(minutes > 0) || minutes > 525600) return { error: 'Minutes must be more than 0 and at most a year.' };
          const deliver = ['text', 'call'].includes(args.deliver) ? args.deliver : 'app';
          if (deliver !== 'app') { try { phone.check(s); } catch (e) { return { error: e.message } } }
          const r = { id: Math.max(0, ...reminders.map(x => x.id)) + 1, message: String(args.message || 'Reminder'), due: Date.now() + minutes * 60000, deliver };
          reminders.push(r);
          saveReminders();
          schedule(r);
          result = { ok: true, id: r.id, due_at: new Date(r.due).toLocaleString() };
          break;
        }
        case 'list_reminders': result = { reminders: publicReminders().map(r => ({ ...r, due: new Date(r.due).toLocaleString() })) }; break;
        case 'cancel_reminder': {
          const id = Number(args.id);
          if (!reminders.some(r => r.id === id)) return { error: `No reminder ${id}.` };
          clearTimeout(timers.get(id));
          timers.delete(id);
          reminders = reminders.filter(r => r.id !== id);
          saveReminders();
          result = { ok: true };
          break;
        }
        case 'save_note': {
          const notes = readJSON('notes.json', []);
          const note = { id: Math.max(0, ...notes.map(n => n.id)) + 1, text: String(args.text), saved: new Date().toLocaleString() };
          notes.push(note);
          writeJSON('notes.json', notes);
          result = { ok: true, id: note.id };
          break;
        }
        case 'get_notes': result = { notes: readJSON('notes.json', []) }; break;
        case 'add_task': {
          const t = { id: Math.max(0, ...tasks.map(x => x.id)) + 1, text: String(args.text), due: args.due ? String(args.due) : '', done: false, added: new Date().toLocaleString() };
          tasks.push(t);
          saveTasks();
          result = { ok: true, id: t.id };
          break;
        }
        case 'list_tasks': result = { tasks: args.include_done ? tasks : tasks.filter(t => !t.done) }; break;
        case 'complete_task': {
          const t = tasks.find(x => x.id === Number(args.id));
          if (!t) return { error: `No task ${args.id}.` };
          t.done = true;
          saveTasks();
          result = { ok: true };
          break;
        }
        case 'delete_task': tasks = tasks.filter(t => t.id !== Number(args.id)); saveTasks(); result = { ok: true }; break;
        case 'schedule_routine': {
          if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(args.time || ''))) return { error: 'Time must be HH:MM in 24-hour format, e.g. 08:00 or 18:30.' };
          const r = {
            id: Math.max(0, ...routines.map(x => x.id)) + 1, instruction: String(args.instruction),
            time: String(args.time).padStart(5, '0'), repeat: ['once', 'daily', 'weekdays', 'weekly'].includes(args.repeat) ? args.repeat : 'daily',
            weekday: args.weekday ? String(args.weekday) : '',
          };
          r.next = nextRun(r);
          if (!r.next) return { error: 'That time is in the past or the weekday is not valid.' };
          routines.push(r);
          saveRoutines();
          result = { ok: true, id: r.id, first_run: new Date(r.next).toLocaleString(), note: 'Runs while Jarvis is open on the main computer.' };
          break;
        }
        case 'list_routines': result = { routines: routines.map(r => ({ ...r, next: new Date(r.next).toLocaleString() })) }; break;
        case 'delete_routine': routines = routines.filter(r => r.id !== Number(args.id)); saveRoutines(); result = { ok: true }; break;
        case 'create_file': {
          if (!ctx.local) return { error: 'Files can only be created from the main computer.' };
          const name = String(args.filename || '').replace(/[^\w .\-()]/g, '').trim().slice(0, 80);
          if (!/\.(txt|md|csv|html|json)$/i.test(name)) return { error: 'Use a .txt, .md, .csv, .html or .json file name.' };
          fs.mkdirSync(filesDir(), { recursive: true });
          let target = path.join(filesDir(), name);
          for (let n = 2; fs.existsSync(target); n++) target = path.join(filesDir(), name.replace(/(\.\w+)$/, ` (${n})$1`));
          fs.writeFileSync(target, String(args.content ?? ''), 'utf8');
          result = { ok: true, saved_to: target };
          break;
        }
        case 'browser_search': case 'browser_open': case 'browser_click': case 'browser_type':
        case 'browser_scroll': case 'browser_back': case 'browser_read': case 'browser_close': {
          if (!ctx.local) return { error: 'The live browser runs on the main computer only.' };
          const a = args;
          result = await ({
            browser_search: () => browser.search(a.query),
            browser_open: () => browser.open(a.url),
            browser_click: () => browser.click(a.target),
            browser_type: () => browser.type(a.field, a.text, a.submit),
            browser_scroll: () => browser.scroll(a.direction),
            browser_back: () => browser.back(),
            browser_read: () => browser.read(),
            browser_close: () => browser.close(),
          })[name]();
          break;
        }
        case 'build_website': {
          if (!ctx.local) return { error: 'Websites are built on the main computer.' };
          const site = siteName(args.name);
          if (!site) return { error: 'Give the website a short name.' };
          const files = Array.isArray(args.files) ? args.files : [];
          if (!files.length) return { error: 'No files were given.' };
          const written = [];
          for (const f of files.slice(0, 40)) {
            const target = sitePath(site, f.path);
            if (!target) return { error: `"${f.path}" is not an allowed file (use .html .css .js .json .svg .txt .md).` };
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(f.content ?? ''), 'utf8');
            written.push(f.path);
          }
          const folder = path.join(sitesDir(), site);
          const url = `${sitesUrl()}/sites/${site}/${fs.existsSync(path.join(folder, 'index.html')) ? '' : written[0]}`;
          broadcast('tool-step', { text: `Website saved to ${folder}` });
          let shown = false;
          try { await browser.open(url); shown = true; } catch {}
          if (!shown) act({ type: 'open', url, label: 'Open website' });
          result = { ok: true, folder, preview: url, files: written, shown_in_browser: shown };
          break;
        }
        case 'read_website_file': {
          const site = siteName(args.name);
          const target = sitePath(site, args.path);
          if (!target || !fs.existsSync(target)) return { error: 'That file does not exist.' };
          result = { content: fs.readFileSync(target, 'utf8').slice(0, 30000) };
          break;
        }
        case 'list_websites': {
          const out = {};
          const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name), base + d.name + '/') : [base + d.name]));
          try { for (const s of fs.readdirSync(sitesDir())) out[s] = walk(path.join(sitesDir(), s)); } catch {}
          result = { folder: sitesDir(), websites: out };
          break;
        }
        case 'make_folder': case 'download_file': case 'move_file': case 'copy_file': case 'list_folder': case 'open_folder': {
          if (!ctx.local) return { error: 'Folders and files are managed on the main computer only.' };
          const bad = p => ({ error: `"${p}" isn't allowed. Use a path inside Documents, Desktop, Downloads, Pictures, Music or Videos.` });
          if (name === 'make_folder') {
            const dir = userPath(args.path);
            if (!dir) return bad(args.path);
            fs.mkdirSync(dir, { recursive: true });
            result = { ok: true, folder: dir };
          } else if (name === 'download_file') {
            const dir = userPath(args.folder);
            if (!dir) return bad(args.folder);
            if (BLOCKED_EXT.test(new URL(args.url).pathname)) return { error: 'That link is a program or script, so I won\'t download it for safety. Open it yourself if you trust it.' };
            let url = await research.assertPublicUrl(args.url);
            let res;
            for (let hop = 0; hop < 5; hop++) {
              res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000), headers: { 'user-agent': 'Mozilla/5.0 JarvisAssistant/1.0' } });
              if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = await research.assertPublicUrl(new URL(res.headers.get('location'), url).href); continue; }
              break;
            }
            if (!res.ok) return { error: `The download failed (HTTP ${res.status}).` };
            const disp = (res.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
            let fileName = String(args.filename || (disp && decodeURIComponent(disp[1])) || decodeURIComponent(path.basename(url.pathname)) || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
            if (!path.extname(fileName)) {
              const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4', 'text/plain': '.txt', 'text/html': '.html', 'application/zip': '.zip' }[(res.headers.get('content-type') || '').split(';')[0]];
              if (ext) fileName += ext;
            }
            if (BLOCKED_EXT.test(fileName)) return { error: 'That looks like a program or script, so I won\'t download it for safety. I can open the link for you to decide.', open_url: url.href };
            const size = Number(res.headers.get('content-length') || 0);
            if (size > 2e9) return { error: 'That file is over 2 GB. Better to download it yourself.' };
            fs.mkdirSync(dir, { recursive: true });
            const target = freeName(path.join(dir, fileName));
            broadcast('tool-step', { text: `Downloading ${fileName}…` });
            await require('stream/promises').pipeline(require('stream').Readable.fromWeb(res.body), fs.createWriteStream(target));
            result = { ok: true, saved_to: target, size_mb: +(fs.statSync(target).size / 1048576).toFixed(2) };
          } else if (name === 'move_file' || name === 'copy_file') {
            const from = userPath(args.from), to = userPath(args.to);
            if (!from) return bad(args.from);
            if (!to) return bad(args.to);
            if (!fs.existsSync(from)) return { error: `Can't find "${args.from}".` };
            const intoFolder = (fs.existsSync(to) && fs.statSync(to).isDirectory()) || !path.extname(to);
            const dest = freeName(intoFolder ? path.join(to, path.basename(from)) : to);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (name === 'move_file') fs.renameSync(from, dest);
            else fs.cpSync(from, dest, { recursive: true, errorOnExist: true, force: false });
            result = { ok: true, [name === 'move_file' ? 'moved_to' : 'copied_to']: dest };
          } else if (name === 'list_folder') {
            const dir = userPath(args.path);
            if (!dir) return bad(args.path);
            if (!fs.existsSync(dir)) return { error: `"${args.path}" doesn't exist.` };
            const items = fs.readdirSync(dir, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 200)
              .map(d => (d.isDirectory() ? d.name + '/' : `${d.name} (${(fs.statSync(path.join(dir, d.name)).size / 1048576).toFixed(1)} MB)`));
            result = { folder: dir, items };
          } else {
            const dir = userPath(args.path);
            if (!dir || !fs.existsSync(dir)) return bad(args.path);
            const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            execFile(opener, [dir], () => {});
            result = { ok: true, opened: dir };
          }
          break;
        }
        case 'list_files': {
          let names = [];
          try { names = fs.readdirSync(filesDir()); } catch {}
          result = { folder: filesDir(), files: names };
          break;
        }
        case 'delete_note': {
          const notes = readJSON('notes.json', []);
          writeJSON('notes.json', notes.filter(n => n.id !== Number(args.id)));
          result = { ok: true };
          break;
        }
        case 'trading_account': case 'market_quote': case 'prepare_trade': {
          if (!ctx.local) return { error: 'Trading is only available on the main computer.' };
          if (ctx.routine) return { error: 'Automatic routines are not allowed to trade.' };
          if (name === 'trading_account') result = await trading.account(args.broker);
          else if (name === 'market_quote') result = await trading.quote(args.broker, args.symbol);
          else {
            const ticket = await trading.prepare(args);
            act({ type: 'trade', ticket });
            result = { ok: true, status: 'Order ticket shown. It is only sent if the person taps "Confirm order".', ticket };
          }
          break;
        }
        case 'text_me': result = await phone.textMe(s, args.message); break;
        case 'call_me': result = await phone.callMe(s, args.message); break;
        case 'copy_to_clipboard': act({ type: 'copy', text: String(args.text) }); result = { ok: true }; break;
        case 'open_app':
          if (!ctx.local) return { error: 'Apps can only be opened on the main computer, not from a phone.' };
          result = await openApp(args.name);
          break;
        case 'system_status': result = systemStatus(); break;
        default: return { error: `Unknown tool ${name}` };
      }
      if (result && result.open_url) act({ type: 'open', url: result.open_url, label: 'Open' });
      return result;
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  return { defs: DEFS, pick: pickTools, run, weather, reminders: publicReminders, systemStatus, tasks: () => tasks, toggleTask, sitesDir, confirmTrade: id => trading.confirm(id) };
}

module.exports = { createTools, SOCIAL };
