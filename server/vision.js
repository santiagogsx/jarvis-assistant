// Eyes: describe a screenshot or camera photo with an AI that can see images.
// Local mode uses a vision model in Ollama (llava, llama3.2-vision, gemma3,
// qwen2.5vl…); otherwise the person's free Gemini/Groq key or a paid account.
const OPENAI_COMPAT = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.0-flash'] },
  groq: { base: 'https://api.groq.com/openai/v1', models: ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'] },
  openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  openrouter: { base: 'https://openrouter.ai/api/v1', models: ['google/gemini-2.5-flash'] },
};
const VISION_LOCAL = /llava|vision|gemma3|qwen2\.5vl|qwen2\.5-vl|minicpm-v|moondream|bakllava|llama4/i;

async function ollamaVisionModel(settings) {
  const base = (settings.ollamaUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
  try {
    const d = await (await fetch(base + '/api/tags', { signal: AbortSignal.timeout(1500) })).json();
    return (d.models || []).map(m => m.name).find(n => VISION_LOCAL.test(n)) || null;
  } catch { return null; }
}

async function callCompat(base, key, model, system, question, dataUrl) {
  const r = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 700, messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ] }),
    signal: AbortSignal.timeout(90000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return (d.choices?.[0]?.message?.content || '').trim();
}

async function look(settings, { image, question, what }) {
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(String(image || ''))) throw new Error('No picture was taken.');
  const me = settings.assistantName || 'Jarvis';
  const system = `You are ${me}, a calm, witty British AI butler. You are looking at ${what === 'camera' ? "a photo from the person's camera" : "a screenshot of the person's computer screen"}. Answer their question about it briefly and helpfully (2-4 sentences unless they ask for detail). Address them as "${settings.userTitle || 'sir'}".`;
  const q = String(question || 'What do you see?').slice(0, 1000);
  const errors = [];

  if (settings.aiMode === 'local') {
    const model = await ollamaVisionModel(settings);
    if (!model) throw new Error('Local mode needs a vision model in Ollama to see. In a terminal run: ollama pull llama3.2-vision  (or gemma3). Or switch to Free AI with the chip under the orb.');
    const base = settings.ollamaUrl || 'http://localhost:11434/v1';
    return { answer: await callCompat(base, 'ollama', model, system, q, image), by: model };
  }

  for (const p of ['gemini', 'groq', 'openai', 'openrouter']) {
    if (!settings.keys[p]) continue;
    for (const model of OPENAI_COMPAT[p].models) {
      try { return { answer: await callCompat(OPENAI_COMPAT[p].base, settings.keys[p], model, system, q, image), by: model }; }
      catch (e) { errors.push(`${p}: ${e.message}`); }
    }
  }
  if (settings.keys.anthropic) {
    try {
      const [, mime, data] = image.match(/^data:(image\/\w+);base64,(.+)$/);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': settings.keys.anthropic, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: settings.models.anthropic || 'claude-sonnet-5-5', max_tokens: 700, system, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: q }] }] }),
        signal: AbortSignal.timeout(90000),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
      return { answer: d.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), by: 'Claude' };
    } catch (e) { errors.push('claude: ' + e.message); }
  }
  const local = await ollamaVisionModel(settings);
  if (local) return { answer: await callCompat(settings.ollamaUrl || 'http://localhost:11434/v1', 'ollama', local, system, q, image), by: local };
  throw new Error(errors.length
    ? `I couldn't look at it: ${errors[0]}`
    : 'To see, I need an AI that understands pictures. Add a free Google Gemini key in Settings → API keys (no credit card): it takes a minute.');
}

module.exports = { look };
