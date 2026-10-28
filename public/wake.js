// "Hey Jarvis" wake word, fully offline. A Vosk recognizer limited to a tiny
// vocabulary listens for "jarvis"; nothing leaves the device. The same engine
// can also transcribe one spoken command for free when no speech-to-text key
// is set.
(() => {
  const MODEL_URL = new URL('models/vosk-model-small-en-us-0.15.tar.gz', location.href).href;
  // The wake phrase follows the assistant's name ("hey friday", "friday"...).
  const grammarFor = name => {
    const n = name.toLowerCase().replace(/[^a-z' ]/g, '').trim() || 'jarvis';
    // Also "stop"/"cancel" so the person can interrupt him mid-task.
    return JSON.stringify([`hey ${n}`, n, `okay ${n}`, `hi ${n}`, `yo ${n}`, `${n} stop`, `${n} cancel`, 'stop', 'cancel', 'never mind', 'be quiet', '[unk]']);
  };

  let modelPromise = null;
  let model = null, ctx = null, stream = null, node = null;
  let wakeRec = null, wakeName = 'jarvis', onWake = null, wakeOn = false, paused = false, coolUntil = 0;
  let capture = null;
  let micId = '';

  function loadScript() {
    if (window.Vosk) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/vosk.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the speech engine.'));
      document.head.append(s);
    });
  }

  function loadModel() {
    if (!modelPromise) {
      modelPromise = loadScript()
        .then(() => window.Vosk.createModel(MODEL_URL, -1))
        .then(m => { model = m; return m; })
        .catch(e => { modelPromise = null; throw e; });
    }
    return modelPromise;
  }

  // One shared microphone pipeline feeds whichever recognizer is active.
  async function ensurePipeline() {
    await loadModel();
    if (ctx) { if (ctx.state === 'suspended') await ctx.resume().catch(() => {}); return; }
    const audio = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
    if (micId) audio.deviceId = { exact: micId };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) { if (!micId) throw e; delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); } // chosen mic unplugged: use default
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = e => {
      try {
        if (capture) capture.rec.acceptWaveform(e.inputBuffer);
        else if (wakeOn && !paused && wakeRec) wakeRec.acceptWaveform(e.inputBuffer);
      } catch {}
    };
    src.connect(node);
    node.connect(ctx.destination); // outputs silence; needed so the processor keeps running
  }

  // Tells the app what was heard: his name ("Jarvis", "Hey Jarvis") and/or a
  // stop word. A bare "stop"/"cancel" only counts as a whole phrase on its own
  // (so him saying "I'll cancel that reminder" doesn't stop himself).
  function heard(text, final) {
    if (!wakeOn || paused || capture || Date.now() < coolUntil) return;
    const name = new RegExp(`\\b${wakeName}\\b`, 'i').test(text);
    const clean = text.replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const stopWord = /\b(stop|cancel|never mind|be quiet)\b/.test(clean);
    const standaloneStop = final && !/\[unk\]/.test(text) && /^(stop|cancel|never mind|be quiet)$/.test(clean);
    if (name || standaloneStop) {
      coolUntil = Date.now() + (stopWord ? 1500 : 2500);
      onWake?.({ name, stop: stopWord, text: clean });
    }
  }

  async function start(cb, name = 'Jarvis') {
    onWake = cb;
    await ensurePipeline();
    const n = name.toLowerCase().replace(/[^a-z' ]/g, '').trim() || 'jarvis';
    if (wakeRec && n !== wakeName) { try { wakeRec.remove(); } catch {} wakeRec = null; }
    wakeName = n;
    if (!wakeRec) {
      wakeRec = new model.KaldiRecognizer(ctx.sampleRate, grammarFor(n));
      wakeRec.on('partialresult', m => heard(m.result?.partial || '', false));
      wakeRec.on('result', m => heard(m.result?.text || '', true));
    }
    wakeOn = true;
    paused = false;
  }

  function stop() { wakeOn = false; }

  function pause() { paused = true; }

  function resume() {
    if (!paused) return;
    paused = false;
    coolUntil = Date.now() + 1200; // ignore anything left over from before the pause
    try { wakeRec?.retrieveFinalResult(); } catch {}
  }

  // Extra language/accent models (downloaded by the server), loaded on demand.
  const extraModels = new Map();
  function loadExtra(url) {
    const abs = new URL(url, location.href).href;
    if (!extraModels.has(abs)) {
      extraModels.set(abs, loadScript().then(() => window.Vosk.createModel(abs, -1)).catch(e => { extraModels.delete(abs); throw e; }));
    }
    return extraModels.get(abs);
  }

  // Transcribe one spoken command (free, offline). Resolves with the text,
  // or '' if nothing was said. modelUrl picks another language/accent model.
  async function listenOnce(onPartial, maxMs = 15000, modelUrl = null) {
    await ensurePipeline();
    const m = modelUrl ? await loadExtra(modelUrl).catch(() => model) : model;
    return new Promise(resolve => {
      const rec = new m.KaldiRecognizer(ctx.sampleRate);
      let last = '', done = false;
      const finish = text => {
        if (done) return;
        done = true;
        capture = null;
        clearTimeout(t1);
        clearTimeout(t2);
        try { rec.remove(); } catch {}
        coolUntil = Date.now() + 1500;
        resolve(String(text || last).trim());
      };
      rec.on('partialresult', m => { const p = m.result?.partial || ''; if (p) { last = p; onPartial?.(p); } });
      rec.on('result', m => { const t = m.result?.text || ''; if (t) finish(t); });
      const t1 = setTimeout(() => finish(last), maxMs);
      const t2 = setTimeout(() => { if (!last) finish(''); }, 7000);
      capture = { rec, cancel: () => finish(last) };
    });
  }

  function cancelCapture() { capture?.cancel(); }

  // Fully let go of the microphone (mic-off switch): the OS shows it as unused.
  async function release() {
    wakeOn = false;
    capture?.cancel();
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    try { node?.disconnect(); } catch {}
    if (ctx) await ctx.close().catch(() => {});
    ctx = null;
    if (wakeRec) { try { wakeRec.remove(); } catch {} wakeRec = null; }
  }

  // Switch microphones: rebuild the audio pipeline on the new one.
  async function setMic(id) {
    if (id === micId) return;
    micId = id || '';
    if (!ctx) return;
    capture?.cancel();
    stream?.getTracks().forEach(t => t.stop());
    try { node.disconnect(); } catch {}
    await ctx.close().catch(() => {});
    ctx = null;
    if (wakeRec) { try { wakeRec.remove(); } catch {} wakeRec = null; }
    if (wakeOn) await start(onWake, wakeName);
  }

  window.wake = {
    get supported() { return !!(navigator.mediaDevices?.getUserMedia) && window.isSecureContext && typeof WebAssembly === 'object'; },
    get running() { return wakeOn; },
    preload: loadModel,
    start, stop, pause, resume, listenOnce, cancelCapture, setMic, release,
  };
})();
