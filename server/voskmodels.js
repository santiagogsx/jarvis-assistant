// Offline speech models for other languages/accents (free, from the Vosk
// project). English (US) ships with the app; the others download once when
// chosen, get repacked as .tar.gz (the format the browser engine reads) and are
// served from the app's data folder.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE = 'https://alphacephei.com/vosk/models/';
const MODELS = {
  'en-in': 'vosk-model-small-en-in-0.4',
  es: 'vosk-model-small-es-0.42',
  fr: 'vosk-model-small-fr-0.22',
  de: 'vosk-model-small-de-0.15',
  pt: 'vosk-model-small-pt-0.3',
  it: 'vosk-model-small-it-0.22',
  hi: 'vosk-model-small-hi-0.22',
};

const run = (cmd, args, cwd) => new Promise((resolve, reject) =>
  execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 1 << 24 }, err => (err ? reject(err) : resolve())));

function createVoskModels(dataDir, onStatus) {
  const dir = path.join(dataDir, 'vosk');
  const jobs = new Map();

  // Which offline model a language setting needs: null = the bundled English one.
  const nameFor = lang => MODELS[lang] || MODELS[String(lang).split('-')[0]] || null;
  const fileFor = name => path.join(dir, name + '.tar.gz');

  function prepare(lang) {
    const name = nameFor(lang);
    if (!name) return Promise.resolve(null);
    if (fs.existsSync(fileFor(name))) return Promise.resolve(name);
    if (!jobs.has(name)) {
      jobs.set(name, (async () => {
        onStatus?.(`Downloading the offline speech model for this language (one time, about 40 MB)…`);
        fs.mkdirSync(dir, { recursive: true });
        const zip = path.join(dir, name + '.zip');
        const res = await fetch(BASE + name + '.zip', { redirect: 'follow' });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        await run('tar', ['-xf', zip], dir);
        await run('tar', ['-czf', name + '.tar.gz', name], dir);
        fs.rmSync(zip, { force: true });
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        onStatus?.('ready');
        return name;
      })().catch(e => { jobs.delete(name); throw e; }));
    }
    return jobs.get(name);
  }

  // Path on disk for a requested model file, or null if not ours.
  function file(requested) {
    const name = path.basename(String(requested), '.tar.gz');
    return Object.values(MODELS).includes(name) && fs.existsSync(fileFor(name)) ? fileFor(name) : null;
  }

  return { prepare, file, nameFor };
}

module.exports = { createVoskModels };
