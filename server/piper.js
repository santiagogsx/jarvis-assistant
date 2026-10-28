// Free, offline neural voices (Piper, MIT licensed) with British male
// options. The engine (~20 MB) and the chosen voice (~65-80 MB) download once
// on first use into the app's data folder.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/';

// id -> model + speaker. Labels are shown in Settings, grouped by `group`.
const VOICES = {
  alan: { model: 'en_GB/alan/medium/en_GB-alan-medium', group: 'British men', label: 'Alan: calm British gentleman (default)' },
  'vctk-p254': { model: 'en_GB/vctk/medium/en_GB-vctk-medium', speaker: 'p254', group: 'British men', label: 'Charles: refined, deeper' },
  'vctk-p226': { model: 'en_GB/vctk/medium/en_GB-vctk-medium', speaker: 'p226', group: 'British men', label: 'Henry: crisp Surrey English' },
  'vctk-p232': { model: 'en_GB/vctk/medium/en_GB-vctk-medium', speaker: 'p232', group: 'British men', label: 'Edward: Southern English' },
  'vctk-p258': { model: 'en_GB/vctk/medium/en_GB-vctk-medium', speaker: 'p258', group: 'British men', label: 'Oliver: younger Southern English' },
  'semaine-obadiah': { model: 'en_GB/semaine/medium/en_GB-semaine-medium', speaker: 'obadiah', group: 'British men', label: 'Obadiah: slow and serious' },
  'semaine-spike': { model: 'en_GB/semaine/medium/en_GB-semaine-medium', speaker: 'spike', group: 'British men', label: 'Spike: lively' },
  northern: { model: 'en_GB/northern_english_male/medium/en_GB-northern_english_male-medium', group: 'British men', label: 'Northern English' },
  'semaine-prudence': { model: 'en_GB/semaine/medium/en_GB-semaine-medium', speaker: 'prudence', group: 'British women', label: 'Prudence: polished, composed' },
  jenny: { model: 'en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium', group: 'British women', label: 'Jenny: warm and clear' },
  cori: { model: 'en_GB/cori/medium/en_GB-cori-medium', group: 'British women', label: 'Cori: bright, friendly' },
  alba: { model: 'en_GB/alba/medium/en_GB-alba-medium', group: 'British women', label: 'Alba: Scottish' },
  norman: { model: 'en_US/norman/medium/en_US-norman-medium', group: 'American men', label: 'Norman: older storyteller' },
  john: { model: 'en_US/john/medium/en_US-john-medium', group: 'American men', label: 'John: mature narrator' },
  ryan: { model: 'en_US/ryan/high/en_US-ryan-high', group: 'American men', label: 'Ryan: clear, confident (high quality)' },
  joe: { model: 'en_US/joe/medium/en_US-joe-medium', group: 'American men', label: 'Joe: relaxed' },
  lessac: { model: 'en_US/lessac/medium/en_US-lessac-medium', group: 'American women', label: 'Lessac: professional' },
  amy: { model: 'en_US/amy/medium/en_US-amy-medium', group: 'American women', label: 'Amy: friendly' },
  kristin: { model: 'en_US/kristin/medium/en_US-kristin-medium', group: 'American women', label: 'Kristin: calm' },
};

function binaryAsset() {
  if (process.platform === 'win32') return 'piper_windows_amd64.zip';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'piper_linux_x86_64.tar.gz';
  return null;
}

function createPiper(dataDir, onStatus) {
  const root = path.join(dataDir, 'piper');
  const exe = path.join(root, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
  const jobs = new Map();

  async function download(url, dest) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const tmp = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }

  // Run each setup step once, even if several requests arrive together.
  const once = (key, fn) => {
    if (!jobs.has(key)) jobs.set(key, fn().catch(e => { jobs.delete(key); throw e; }));
    return jobs.get(key);
  };

  function ensureEngine() {
    return once('engine', async () => {
      if (fs.existsSync(exe)) return;
      const asset = binaryAsset();
      if (!asset) throw new Error('The free British voice is not available for this computer type.');
      onStatus?.('Downloading the voice engine (one time, about 20 MB)…');
      const archive = path.join(root, asset);
      await download(RELEASE + asset, archive);
      // Windows 10+ and macOS both ship a tar that also opens .zip files.
      await new Promise((resolve, reject) => execFile('tar', ['-xf', archive, '-C', root], err => (err ? reject(err) : resolve())));
      fs.rmSync(archive, { force: true });
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      if (!fs.existsSync(exe)) throw new Error('The voice engine did not unpack correctly.');
    });
  }

  function ensureModel(model) {
    return once('model:' + model, async () => {
      const file = path.join(root, 'voices', path.basename(model) + '.onnx');
      if (fs.existsSync(file) && fs.existsSync(file + '.json')) return file;
      onStatus?.('Downloading this voice (one time, about 60-110 MB)…');
      await download(VOICES_BASE + model + '.onnx.json', file + '.json');
      await download(VOICES_BASE + model + '.onnx', file);
      return file;
    });
  }

  async function prepare(voiceId) {
    const v = VOICES[voiceId] || VOICES.alan;
    await ensureEngine();
    const model = await ensureModel(v.model);
    let speaker;
    if (v.speaker) speaker = JSON.parse(fs.readFileSync(model + '.json', 'utf8')).speaker_id_map?.[v.speaker];
    return { model, speaker };
  }

  // Text -> WAV audio (base64).
  async function synth(text, voiceId, rate = 1) {
    const { model, speaker } = await prepare(voiceId);
    const out = path.join(os.tmpdir(), `jarvis-voice-${crypto.randomBytes(6).toString('hex')}.wav`);
    // Piper's "length scale" is the inverse of speed; Jarvis speaks a touch slower than default.
    const lengthScale = (1.08 / Math.min(Math.max(Number(rate) || 1, 0.6), 1.6)).toFixed(2);
    const args = ['--model', model, '--output_file', out, '--length_scale', lengthScale, '--sentence_silence', '0.25'];
    if (speaker !== undefined) args.push('--speaker', String(speaker));
    await new Promise((resolve, reject) => {
      const p = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve() : reject(new Error('Voice engine error: ' + err.slice(-200)))));
      p.stdin.end(String(text).replace(/\s+/g, ' ').slice(0, 4000));
    });
    const audio = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    return audio;
  }

  const voices = () => Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label, group: v.group }));

  return { synth, prepare, voices, supported: !!binaryAsset() };
}

module.exports = { createPiper };
