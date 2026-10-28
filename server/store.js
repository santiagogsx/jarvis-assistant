// Settings storage. API keys are encrypted with the OS keychain when running
// as the desktop app (Electron safeStorage); the headless server can also read
// keys from environment variables so it can be hosted in the cloud.
const fs = require('fs');
const path = require('path');

// 'email' is the mailbox (app) password; 'spotifyRefresh' is set by the Spotify login, never typed.
const KEY_FIELDS = ['openai', 'anthropic', 'grok', 'gemini', 'openrouter', 'custom', 'groq', 'elevenlabs', 'mistral', 'cerebras', 'tavily', 'brave', 'email', 'twilio', 'alpacaKey', 'alpacaSecret', 'oandaToken', 'spotifyRefresh'];

const ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  grok: 'XAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  custom: 'CUSTOM_API_KEY',
  groq: 'GROQ_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  email: 'EMAIL_PASSWORD',
  twilio: 'TWILIO_AUTH_TOKEN',
};

const DEFAULTS = {
  provider: 'free',
  models: {
    free: 'auto',
    groq: 'llama-3.3-70b-versatile',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-5-5',
    grok: 'grok-4',
    gemini: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini',
    ollama: 'llama3.1',
    custom: '',
  },
  customBaseUrl: '',
  ollamaUrl: 'http://localhost:11434/v1',
  assistantName: 'Jarvis',
  browser: 'auto',       // live-research browser: auto | chrome | msedge | brave
  userName: '',
  namePronounce: '',
  userTitle: 'sir',
  homeCity: '',
  units: 'imperial',
  voice: {
    engine: 'piper',
    piperVoice: 'alan',
    systemVoice: '',
    rate: 1,
    pitch: 0.9,
    openaiVoice: 'fable',
    elevenVoiceId: '',
  },
  sttEngine: 'auto',
  sttLanguage: 'auto',   // Whisper language hint + which offline model to use
  sttWords: '',          // names/places/slang to help recognition
  email: { preset: 'gmail', user: '', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  music: { service: 'spotify', spotifyClientId: '' },
  phone: { twilioSid: '', twilioFrom: '', myNumber: '' },
  // Practice accounts unless live mode is chosen AND confirmed.
  trading: { alpacaMode: 'paper', oandaMode: 'practice', oandaAccount: '', liveConfirmed: false },
  port: 7777,
  remote: { enabled: false, passcode: '' },
  keys: {},
};

function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

function createStore(dataDir, box) {
  const file = path.join(dataDir, 'settings.json');
  let cache;

  const encrypt = v => (box ? 'enc:' + box.encrypt(v) : v);
  const decrypt = v => {
    if (!v) return '';
    if (!v.startsWith('enc:')) return v;
    try { return box ? box.decrypt(v.slice(4)) : ''; } catch { return ''; }
  };

  function load() {
    if (cache) return cache;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    cache = merge(structuredClone(DEFAULTS), raw);
    // Older installs defaulted to the robotic built-in voice: move them to the free British voice once.
    if (raw.voice && !raw.voice.piperVoice && cache.voice.engine === 'system') cache.voice.engine = 'piper';
    return cache;
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  }

  // Full settings with real keys. Only ever used inside the server.
  function get() {
    const s = structuredClone(load());
    for (const k of KEY_FIELDS) s.keys[k] = decrypt(s.keys[k]) || process.env[ENV_KEYS[k]] || '';
    s.remote.passcode = decrypt(s.remote.passcode) || process.env.JARVIS_PASSCODE || '';
    if (process.env.JARVIS_PASSCODE) s.remote.enabled = true;
    if (process.env.JARVIS_PROVIDER) s.provider = process.env.JARVIS_PROVIDER;
    if (process.env.JARVIS_MODEL) s.models[s.provider] = process.env.JARVIS_MODEL;
    return s;
  }

  // Safe to send to the browser: no keys, no passcode.
  function getPublic() {
    const s = get();
    const out = structuredClone(s);
    out.hasKey = Object.fromEntries(KEY_FIELDS.map(k => [k, !!s.keys[k]]));
    out.remote = { enabled: s.remote.enabled, hasPasscode: !!s.remote.passcode };
    delete out.keys;
    return out;
  }

  function update(patch) {
    const s = load();
    const { keys, remote, ...rest } = patch || {};
    merge(s, rest);
    for (const [k, v] of Object.entries(keys || {})) {
      if (KEY_FIELDS.includes(k) && typeof v === 'string' && v.trim()) s.keys[k] = encrypt(v.trim());
    }
    if (remote) {
      if (typeof remote.enabled === 'boolean') s.remote.enabled = remote.enabled;
      if (typeof remote.passcode === 'string' && remote.passcode.trim()) s.remote.passcode = encrypt(remote.passcode.trim());
    }
    save();
    return getPublic();
  }

  function clearKeys() {
    load().keys = {};
    save();
    return getPublic();
  }

  // For secrets the app sets itself (e.g. the Spotify refresh token).
  function setSecret(name, value) {
    const s = load();
    if (value) s.keys[name] = encrypt(value);
    else delete s.keys[name];
    save();
  }

  return { get, getPublic, update, clearKeys, setSecret, dataDir };
}

module.exports = { createStore, KEY_FIELDS };
