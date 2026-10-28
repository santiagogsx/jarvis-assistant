// Talks to any AI platform. Anthropic (Claude) has its own API; everything
// else (OpenAI/ChatGPT, xAI/Grok, Google Gemini, OpenRouter, Ollama, or any
// custom OpenAI-compatible server) speaks the OpenAI chat-completions format.
const COMPAT = {
  groq: s => ({ base: 'https://api.groq.com/openai/v1', key: s.keys.groq }),
  mistral: s => ({ base: 'https://api.mistral.ai/v1', key: s.keys.mistral }),
  cerebras: s => ({ base: 'https://api.cerebras.ai/v1', key: s.keys.cerebras }),
  // No key, no signup; limited to about 1 reply every 30 seconds.
  pollinations: () => ({ url: 'https://text.pollinations.ai/openai', key: 'none', waitOnLimit: true }),
  openai: s => ({ base: 'https://api.openai.com/v1', key: s.keys.openai }),
  grok: s => ({ base: 'https://api.x.ai/v1', key: s.keys.grok }),
  gemini: s => ({ base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: s.keys.gemini }),
  openrouter: s => ({ base: 'https://openrouter.ai/api/v1', key: s.keys.openrouter, extra: { 'HTTP-Referer': 'https://github.com/jarvis-desktop', 'X-Title': 'Jarvis' } }),
  ollama: s => ({ base: s.ollamaUrl || 'http://localhost:11434/v1', key: 'ollama' }),
  custom: s => ({ base: s.customBaseUrl, key: s.keys.custom || 'none' }),
};

const NAMES = {
  free: 'Free AI', groq: 'Groq (free)', mistral: 'Mistral (free)', cerebras: 'Cerebras (free)', pollinations: 'Free starter AI',
  openai: 'OpenAI (ChatGPT)', anthropic: 'Anthropic (Claude)', grok: 'xAI (Grok)', gemini: 'Google Gemini',
  openrouter: 'OpenRouter', ollama: 'Ollama', custom: 'custom provider',
};

// Research can take several search + read-page rounds.
const MAX_STEPS = 12;

async function postJSON(url, headers, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch {
    const local = /localhost|127\.0\.0\.1/.test(url);
    throw new Error(`Couldn't reach ${new URL(url).host}. ${local ? 'Is Ollama running?' : 'Check the internet connection.'}`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const raw = data?.error?.message || data?.error || data?.message || text.slice(0, 300);
    const err = new Error(`${res.status}: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function cleanHistory(history) {
  const h = (Array.isArray(history) ? history : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (h.length && h[0].role !== 'user') h.shift();
  return h;
}

// Each free service has a daily limit; listing several (and a backup model on
// each) means Jarvis just moves to the next one when a limit is reached.
const FREE_MODELS = {
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  cerebras: ['gpt-oss-120b', 'llama-3.3-70b', 'llama3.1-8b'],
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'],
  mistral: ['mistral-small-latest', 'open-mistral-nemo'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free', 'qwen/qwen3-235b-a22b:free'],
  pollinations: ['openai'],
};

async function ollamaReady(settings) {
  try {
    const base = (settings.ollamaUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const r = await fetch(base + '/models', { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    const d = await r.json();
    const want = settings.models.ollama || 'llama3.1';
    return (d.data || []).some(m => m.id === want || m.id.startsWith(want + ':'));
  } catch { return false; }
}

// The free chain: best free option the person has, then the next.
async function freeChain(settings) {
  const order = [];
  const add = provider => { for (const model of FREE_MODELS[provider]) order.push({ provider, model }); };
  if (settings.keys.groq) add('groq');
  if (settings.keys.cerebras) add('cerebras');
  if (settings.keys.gemini) add('gemini');
  if (settings.keys.mistral) add('mistral');
  if (settings.keys.openrouter) add('openrouter');
  // Ollama on this PC has no limit at all: the backstop before the slow starter AI.
  if (await ollamaReady(settings)) order.push({ provider: 'ollama', model: settings.models.ollama || 'llama3.1' });
  add('pollinations');
  return order;
}

// Errors where trying another AI makes sense (bad/expired key, out of credit, rate limit, outage, offline).
const worthFallback = e => !e.status || [401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(e.status);

async function chat(opts) {
  const { settings } = opts;
  const msgs = cleanHistory(opts.history);
  if (!msgs.length) throw new Error('Nothing to answer.');
  const run = (provider, model) => chatWith({ ...opts, provider, model, msgs });

  if (settings.provider === 'free') {
    let lastErr;
    for (const { provider, model } of await freeChain(settings)) {
      // Any failure (limit reached, model retired, outage): just try the next free option.
      try { return await run(provider, model); } catch (e) { lastErr = e; }
    }
    throw new Error(`All the free AIs are busy right now (${lastErr?.message}). Wait a moment, or add more free keys (Groq, Cerebras, Mistral) or set up unlimited Ollama in Settings → AI.`);
  }

  try {
    return await run(settings.provider, (settings.models[settings.provider] || '').trim());
  } catch (e) {
    if (!worthFallback(e) || e.noFallback) throw e;
    // The paid/selected AI failed: keep working on the free chain instead.
    for (const { provider, model } of await freeChain(settings)) {
      try {
        const reply = await run(provider, model);
        return `${reply}\n\n(Your ${NAMES[settings.provider] || settings.provider} connection failed: ${e.message.slice(0, 120).replace(/\.+$/, '')}. I answered with ${NAMES[provider]} instead.)`;
      } catch {}
    }
    throw e;
  }
}

async function chatWith({ settings, provider: p, model, msgs, systemPrompt, toolDefs, runTool }) {
  if (!model) throw Object.assign(new Error(`No model is set for ${NAMES[p] || p}. Open Settings and enter one.`), { noFallback: true });

  if (p === 'anthropic') {
    if (!settings.keys.anthropic) throw new Error('No Claude API key saved yet. Open Settings (gear icon) and paste it in.');
    return anthropicChat(settings.keys.anthropic, model, msgs, systemPrompt, toolDefs, runTool);
  }
  const cfg = COMPAT[p]?.(settings);
  if (!cfg) throw new Error('Unknown AI provider: ' + p);
  if (!cfg.base && !cfg.url) throw Object.assign(new Error('Set the base URL for your custom provider in Settings.'), { noFallback: true });
  if (!cfg.key) throw Object.assign(new Error(`No ${NAMES[p]} API key saved yet. Open Settings (gear icon) and paste it in.`), { status: 401 });
  return compatChat(cfg, model, msgs, systemPrompt, toolDefs, runTool);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function compatChat({ base, url: fullUrl, key, extra, waitOnLimit }, model, history, system, toolDefs, runTool) {
  const url = fullUrl || base.replace(/\/+$/, '') + '/chat/completions';
  const headers = { authorization: `Bearer ${key}`, ...(extra || {}) };
  const post = async body => {
    try {
      return await postJSON(url, headers, body);
    } catch (e) {
      // The no-signup service allows one reply every ~30s: wait once, then retry.
      const wait = Number((e.message.match(/retry after (\d+)/i) || [])[1]);
      if (waitOnLimit && (e.status === 402 || e.status === 429) && wait && wait <= 35) {
        await sleep((wait + 1) * 1000);
        return postJSON(url, headers, body);
      }
      throw e;
    }
  };
  const messages = [{ role: 'system', content: system }, ...history];
  let tools = toolDefs.map(t => ({ type: 'function', function: t }));
  let retried = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    let data;
    try {
      data = await post({ model, messages, ...(tools.length ? { tools } : {}) });
    } catch (e) {
      // Some local models can't use tools: retry once as plain chat.
      if (tools.length && !retried && e.status === 400 && /tool|function/i.test(e.message)) {
        tools = [];
        retried = true;
        step--;
        continue;
      }
      throw e;
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('The AI sent back an empty answer.');
    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        const result = await runTool(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    // Some free models put their answer only in a "reasoning" field.
    return (msg.content || '').trim() || (msg.reasoning_content || '').trim();
  }
  return "That took more steps than I'm permitted. Could you narrow it down?";
}

async function anthropicChat(key, model, history, system, toolDefs, runTool) {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  const tools = toolDefs.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await postJSON('https://api.anthropic.com/v1/messages', headers, { model, max_tokens: 1500, system, messages, tools });
    const uses = (data.content || []).filter(b => b.type === 'tool_use');
    if (data.stop_reason === 'tool_use' && uses.length) {
      messages.push({ role: 'assistant', content: data.content });
      const results = [];
      for (const u of uses) {
        const result = await runTool(u.name, u.input || {});
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
  return "That took more steps than I'm permitted. Could you narrow it down?";
}

module.exports = { chat, NAMES, ollamaReady };
