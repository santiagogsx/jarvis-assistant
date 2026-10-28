// Premium voices (OpenAI / ElevenLabs) and speech-to-text (OpenAI Whisper / Groq).
// The free built-in system voice is handled in the browser instead.
async function errorText(res) {
  const t = await res.text();
  try { const d = JSON.parse(t); return d.error?.message || d.detail?.message || d.detail || t; } catch { return t.slice(0, 200); }
}

// Returns { audio: base64, mime }.
async function tts(text, s, piper) {
  const v = s.voice;
  const input = String(text || '').slice(0, 4000);
  if (v.engine === 'piper') {
    if (!piper?.supported) throw new Error('The free British voice is not available on this computer.');
    return { audio: await piper.synth(input, v.piperVoice, v.rate), mime: 'audio/wav' };
  }
  if (v.engine === 'voicestudio') {
    // A cloned voice from VoiceStudio. Only with the voice owner's permission (confirmed in Settings).
    if (!v.cloneConsent) throw new Error('Confirm in Settings → Voice that you have permission to use this voice.');
    try {
      return { audio: await voiceStudioSpeak(v, input), mime: 'audio/wav' };
    } catch (e) {
      // VoiceStudio closed or busy: keep talking with the British voice instead of going silent.
      if (piper?.supported) return { audio: await piper.synth(input, v.piperVoice || 'alan', v.rate), mime: 'audio/wav', note: 'VoiceStudio unavailable: ' + e.message };
      throw e;
    }
  }
  if (v.engine === 'openai') {
    if (!s.keys.openai) throw new Error('The OpenAI voice needs an OpenAI key in Settings.');
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.keys.openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts', voice: v.openaiVoice || 'fable', input, response_format: 'mp3',
        instructions: 'Accent: refined Received Pronunciation British English. Voice: a composed, mature male AI butler. ' +
          'Tone: calm, warm but precise, never excited; dry, understated wit that shows in slight pauses rather than laughter. ' +
          'Delivery: measured, unhurried pace, crisp consonants, gentle downward inflection at the end of sentences, ' +
          'a hint of polite deference when addressing the listener. Sound like a highly capable assistant who has everything under control.',
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return { audio: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: 'audio/mpeg' };
  }
  if (v.engine === 'elevenlabs') {
    if (!s.keys.elevenlabs || !v.elevenVoiceId) throw new Error('ElevenLabs needs an API key and a voice ID in Settings.');
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.elevenVoiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': s.keys.elevenlabs, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: input, model_id: 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    return { audio: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: 'audio/mpeg' };
  }
  throw new Error('Using the built-in voice.');
}

// ---- VoiceStudio (local voice cloning app): OpenAI-compatible /v1/audio/speech
const vsBase = v => String(v.vsUrl || 'http://127.0.0.1:3900').replace(/\/+$/, '');
function assertLocalUrl(u) {
  // Only talk to a VoiceStudio on this computer or the home network, never somewhere on the internet.
  const host = new URL(u).hostname;
  if (!/^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host)) throw new Error('VoiceStudio address must be on this computer or your home network.');
}

async function voiceStudioSpeak(v, input) {
  if (!v.vsVoice) throw new Error('Pick your cloned voice in Settings → Voice.');
  assertLocalUrl(vsBase(v));
  const res = await fetch(vsBase(v) + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: v.vsVoice, input, response_format: 'wav', speed: Number(v.rate) || 1 }),
    signal: AbortSignal.timeout(120000),
  }).catch(() => { throw new Error('VoiceStudio is not running. Open the VoiceStudio app.'); });
  if (!res.ok) throw new Error(await errorText(res));
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

async function voiceStudioVoices(v) {
  assertLocalUrl(vsBase(v));
  const res = await fetch(vsBase(v) + '/v1/audio/voices', { signal: AbortSignal.timeout(5000) })
    .catch(() => { throw new Error('VoiceStudio is not running. Install and open it, then press Refresh.'); });
  if (!res.ok) throw new Error(await errorText(res));
  const d = await res.json();
  const list = Array.isArray(d) ? d : d.voices || d.data || [];
  return list.map(x => ({ id: x.voice_id || x.id, name: x.name || x.voice_id || x.id })).filter(x => x.id);
}

function sttConfig(s) {
  // 'auto': the best key available; with none, the app uses its free offline engine.
  if (s.sttEngine === 'auto') return sttConfig({ ...s, sttEngine: s.keys.groq ? 'groq' : 'openai' });
  if (s.sttEngine === 'groq') return { url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: s.keys.groq, model: 'whisper-large-v3-turbo', name: 'Groq (free key at console.groq.com)' };
  return { url: 'https://api.openai.com/v1/audio/transcriptions', key: s.keys.openai, model: 'whisper-1', name: 'OpenAI' };
}

function sttReady(s) {
  if (s.sttEngine === 'off') return { ok: false, message: 'Voice input is switched off in Settings → Voice. You can type instead.' };
  const c = sttConfig(s);
  if (!c.key) return { ok: false, offline: true, message: `To understand your voice, Jarvis uses ${c.name}. Add that key in Settings → API keys, or type instead.` };
  return { ok: true };
}

async function transcribe(buf, mime, s) {
  const c = sttConfig(s);
  if (!c.key) throw new Error(sttReady(s).message);
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `speech.${ext}`);
  form.append('model', c.model);
  // Language hint ("en-in" -> "en") and the person's own words help with accents and names.
  const lang = String(s.sttLanguage || 'auto').split('-')[0];
  if (lang && lang !== 'auto') form.append('language', lang);
  const words = [s.userName, s.assistantName, s.homeCity, s.sttWords].filter(Boolean).join(', ');
  if (words) form.append('prompt', `Names and words that may come up: ${words}.`.slice(0, 800));
  const res = await fetch(c.url, { method: 'POST', headers: { authorization: `Bearer ${c.key}` }, body: form });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).text || '';
}

module.exports = { tts, transcribe, sttReady, voiceStudioVoices };
