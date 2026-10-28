// Reflex: a fast decision layer that runs before the main AI (like a "System 1").
// It answers five quick questions about a request:
//   lane      - which area should handle it (email, calendar, music, vault…)
//   complete  - did the person finish their request, or were they cut off?
//   addressed - are they talking TO the assistant (vs. background talk / TV)?
//   stakes    - would acting send, buy, delete, post or spend something?
//   vault     - do their own notes (Second Brain) directly answer it?
// Uses Groq's / Cerebras' fastest small model when a free key is saved;
// otherwise instant built-in rules. Vault is always answered locally.

const LANES = {
  chat: 'small talk, opinions, general knowledge',
  vault: "the person's own notes, life, business, projects, people they know",
  calendar: 'schedule, meetings, events, plans',
  email: 'reading, finding or writing email',
  reminders: 'reminders, timers, to-do list, routines',
  music: 'playing, pausing or controlling music',
  weather: 'weather and forecast',
  research: 'looking things up online, news, live browser',
  shopping: 'finding products, prices, orders',
  trading: 'stocks, crypto, forex, brokerage',
  files: 'folders, files, downloads, documents',
  website: 'building or analysing websites',
  phone: 'texting or calling the owner',
  social: 'social media posts and sites',
  eyes: "looking at the screen or camera",
  apps: 'opening apps or websites on the computer',
};

// Tools that belong to each lane (the router adds these to the core tools).
const LANE_TOOLS = {
  vault: ['search_brain', 'remember'],
  calendar: ['calendar_events', 'add_calendar_event'],
  email: ['check_email', 'search_email', 'read_email', 'draft_email'],
  reminders: ['set_reminder', 'list_reminders', 'cancel_reminder', 'add_task', 'list_tasks', 'complete_task', 'delete_task', 'schedule_routine', 'list_routines', 'delete_routine'],
  music: ['music'],
  weather: ['get_weather'],
  research: ['web_search', 'read_webpage', 'get_news', 'browser_search', 'browser_open', 'browser_click', 'browser_read', 'browser_scroll', 'browser_back'],
  shopping: ['find_products', 'prepare_order', 'read_webpage'],
  trading: ['trading_account', 'market_quote', 'prepare_trade'],
  files: ['make_folder', 'download_file', 'move_file', 'copy_file', 'list_folder', 'open_folder', 'create_file', 'list_files'],
  website: ['build_website', 'read_website_file', 'list_websites', 'analyze_website', 'browser_open'],
  phone: ['text_me', 'call_me'],
  social: ['open_social', 'draft_social_post'],
  apps: ['open_app', 'open_website'],
  chat: [], eyes: [],
};

const RULES = [
  ['eyes', /on (my|the|this) screen|what do you see|look at (me|this)|camera/i],
  ['calendar', /calendar|schedule|meeting|appointment|agenda|what('?s| is) (on|happening) (today|tomorrow|this week)|am i (free|busy)/i],
  ['email', /e-?mail|inbox|gmail|unread|reply to|message from/i],
  ['music', /\b(play|pause|resume|skip|next song|previous song|volume|what('?s| is) playing)\b|spotify|apple music/i],
  ['weather', /weather|forecast|temperature|rain|snow|sunny|cold|hot outside/i],
  ['reminders', /remind|reminder|timer|to-?do|my list|task|every (day|morning|week|monday|tuesday|wednesday|thursday|friday)|routine/i],
  ['trading', /stock|shares?\b|crypto|bitcoin|btc|forex|trade|portfolio|alpaca|oanda/i],
  ['shopping', /\b(buy|order|shop|amazon|ebay|walmart|cheapest|best price|deal)\b/i],
  ['phone', /text me|call me|wake me/i],
  ['social', /tweet|instagram|facebook|tiktok|linkedin|post (on|to)|caption/i],
  ['website', /website|web ?site|landing page|how (was|is) .* (made|built)|tech ?stack/i],
  ['files', /folder|download|move (the |my )?file|copy (the |my )?file|documents|desktop/i],
  ['apps', /^(open|launch|start) /i],
  ['research', /research|look (it )?up|search|news|who (is|was)|latest|price of|how (much|many)/i],
  ['vault', /\bmy (notes?|brain|vault|business|project|brand|plan|client|team|goals?)\b|remember|do i (have|know)|what did i/i],
];

const STAKES = /\b(send|email (him|her|them)|reply|buy|order|purchase|pay|transfer|sell|trade|delete|remove|erase|cancel (my|the) (order|subscription)|post|publish|tweet|call (him|her|them)|text (him|her|them))\b/i;
const TRAILING = /\b(and|to|the|a|an|my|for|with|about|of|or|but|so|is|at|on|in|from|that)\s*[.,]?$/i;

function rules(text, assistantName) {
  const t = String(text).trim();
  const laneHit = RULES.find(([, re]) => re.test(t));
  const words = t.split(/\s+/).filter(Boolean).length;
  const named = new RegExp(`\\b${(assistantName || 'jarvis').toLowerCase()}\\b`, 'i').test(t);
  const imperative = /^(please |hey |ok |okay )?(what|who|when|where|why|how|can|could|would|will|do|does|did|is|are|tell|show|give|find|open|play|set|add|remind|send|check|read|search|look|make|build|create|call|text|turn|stop|start|help)\b/i.test(t);
  // Long, rambling speech that starts like a story and never asks anything sounds like background talk.
  const chatter = !named && !imperative && !/\?$/.test(t) && words > 14 && /^(yeah|yes|no|so|and|um+|uh+|like|then|well|she|he|they|we|my (mom|dad|friend|brother|sister)|you know)\b/i.test(t);
  return {
    lane: laneHit ? laneHit[0] : 'chat',
    lane_conf: laneHit ? 0.82 : 0.6,
    complete: words <= 1 || TRAILING.test(t) ? 0.3 : 0.9,
    addressed: named || imperative || /\?$/.test(t) ? 0.95 : chatter ? 0.15 : words > 18 ? 0.45 : 0.75,
    stakes: STAKES.test(t) ? 0.85 : 0.08,
  };
}

async function fastModel(text, history, settings) {
  const recent = (history || []).slice(-4).map(m => `${m.role}: ${String(m.content).slice(0, 200)}`).join('\n');
  const prompt = `Classify the LAST user message for a voice assistant named ${settings.assistantName || 'Jarvis'}. Reply with JSON only:
{"lane": one of ${JSON.stringify(Object.keys(LANES))},
 "lane_conf": 0-1, "complete": 0-1 (1 = the request is finished, low if cut off mid-sentence),
 "addressed": 0-1 (1 = clearly speaking to the assistant; low if it sounds like background talk, TV, or talking to someone else),
 "stakes": 0-1 (1 = acting would send, buy, sell, delete, post, call or spend something)}
Lanes: ${Object.entries(LANES).map(([k, v]) => `${k}=${v}`).join('; ')}
Recent conversation:\n${recent}\nLAST user message: ${String(text).slice(0, 500)}`;
  const tries = [];
  if (settings.keys.groq) tries.push(['https://api.groq.com/openai/v1/chat/completions', settings.keys.groq, 'llama-3.1-8b-instant', 'Groq']);
  if (settings.keys.cerebras) tries.push(['https://api.cerebras.ai/v1/chat/completions', settings.keys.cerebras, 'llama3.1-8b', 'Cerebras']);
  for (const [url, key, model, name] of tries) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 120, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(2500), // a reflex must be quick; otherwise fall back to rules
      });
      if (!r.ok) continue;
      const d = JSON.parse((await r.json()).choices[0].message.content);
      const n = v => Math.min(1, Math.max(0, Number(v) || 0));
      if (!LANES[d.lane]) continue;
      return { lane: d.lane, lane_conf: n(d.lane_conf), complete: n(d.complete), addressed: n(d.addressed), stakes: n(d.stakes), by: `${name} ${model}` };
    } catch {}
  }
  return null;
}

// verdict for each question: ACT, ASK (finish your sentence), CONFIRM, IGNORE, FOUND / CLEAR
async function decide({ text, history, settings, brain, fromVoice }) {
  const t0 = Date.now();
  const useModel = settings.aiMode !== 'local';
  const [model, hits] = await Promise.all([
    useModel ? fastModel(text, history, settings) : null,
    Promise.resolve().then(() => { try { return brain.search(text, 3); } catch { return []; } }),
  ]);
  const d = model || { ...rules(text, settings.assistantName), by: 'built-in rules' };
  // Vault: how much of the question the best note covers, plus a bonus when its title matches.
  const top = hits[0];
  const vault = top ? Math.min(0.99, (top.coverage ?? 0) * 0.75 + (top.titleHit ? 0.2 : 0) + Math.min(0.1, (top.score || 0) / 40)) : 0;
  if (vault >= 0.55 && d.lane === 'chat') { d.lane = 'vault'; d.lane_conf = Math.max(d.lane_conf, vault); }
  const out = {
    lane: d.lane,
    questions: [
      { key: 'lane', label: 'Lane', help: 'Which lane should take this?', value: d.lane_conf, answer: d.lane, verdict: 'ACT' },
      { key: 'complete', label: 'Complete', help: 'Has the person finished the request?', value: d.complete, verdict: d.complete < 0.45 ? 'ASK' : 'ACT' },
      { key: 'addressed', label: 'Addressed', help: 'Talking to me, not to someone else?', value: d.addressed, verdict: fromVoice && d.addressed < 0.3 ? 'IGNORE' : 'ACT' },
      { key: 'stakes', label: 'Stakes', help: 'Would acting send, buy, delete or spend?', value: d.stakes, verdict: d.stakes >= 0.6 ? 'CONFIRM' : 'CLEAR' },
      { key: 'vault', label: 'Vault has it', help: 'Do your notes directly answer this?', value: vault, verdict: vault >= 0.55 ? 'FOUND' : 'NO' },
    ],
    vaultHits: vault >= 0.55 ? hits : [],
    tools: LANE_TOOLS[d.lane] || [],
    by: d.by,
    ms: Date.now() - t0,
  };
  out.action = out.questions.find(q => q.verdict === 'IGNORE') ? 'ignore' : out.questions.find(q => q.verdict === 'ASK') ? 'ask' : out.questions.find(q => q.verdict === 'CONFIRM') ? 'confirm' : 'act';
  return out;
}

module.exports = { decide, LANES, LANE_TOOLS };
