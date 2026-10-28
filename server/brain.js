// Second Brain: everything Jarvis knows about the person, searchable and drawn
// as a map. Sources: Jarvis's own Brain notes (Documents\Jarvis\Brain), the
// Jarvis documents folder, saved notes/tasks, and any folders the person adds.
// All indexing and searching happens locally.
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEXT_EXT = /\.(md|markdown|txt|csv|json|html?|org|rtf|log)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 300_000;
const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those ' +
  'i me my we our you your he she they them their his her him not no yes do does did done have has had can could would should will just ' +
  'so very more most some any all each other into over under about after before than too also only own same such out up down off again ' +
  'here there when where why how what which who whom what\'s it\'s i\'m don\'t can\'t won\'t get got make made one two new use used using ' +
  'like need want know see way time day year www http https com html amp nbsp span div class style href').split(' '));

function words(text) {
  return String(text).toLowerCase().replace(/<[^>]+>/g, ' ').match(/[a-z0-9][a-z0-9'_-]{1,30}/g)?.filter(w => !STOP.has(w) && !/^\d+$/.test(w)) || [];
}

function createBrain({ dataDir, getSettings }) {
  const home = os.homedir();
  const brainDir = () => path.join(home, 'Documents', 'Jarvis', 'Brain');
  const jarvisDir = () => path.join(home, 'Documents', 'Jarvis');
  let index = null;         // { docs, df, avgLen, built }
  let building = null;

  function sourceFolders() {
    const extra = (getSettings().brain?.folders || []).filter(f => f && fs.existsSync(f));
    return [...new Set([jarvisDir(), ...extra])];
  }

  function walk(dir, out, depth = 0) {
    if (out.length >= MAX_FILES || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out, depth + 1);
      else if (TEXT_EXT.test(e.name)) out.push(p);
    }
  }

  function readDoc(file) {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) return null;
      let text = fs.readFileSync(file, 'utf8');
      if (/\.html?$/i.test(file)) text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
      return { text, mtime: st.mtimeMs };
    } catch { return null; }
  }

  // Build (or refresh) the search index: one document per chunk of a file.
  function build() {
    const files = [];
    for (const f of sourceFolders()) walk(f, files);
    const docs = [];
    const s = getSettings();
    const pushDoc = (id, title, kind, text, folder, extra = {}) => {
      // Split long files into ~900 character chunks so search finds the right part.
      const parts = text.length > 1200 ? text.match(/[\s\S]{1,900}(\s|$)/g) : [text];
      parts.forEach((chunk, n) => {
        const w = words(chunk);
        const tf = {};
        for (const x of w) tf[x] = (tf[x] || 0) + 1;
        docs.push({ id, title, kind, folder, chunk: n, text: chunk, tf, len: w.length || 1, ...extra });
      });
    };
    for (const file of files) {
      const d = readDoc(file);
      if (!d || !d.text.trim()) continue;
      const rel = path.relative(home, file);
      const kind = file.startsWith(brainDir()) ? 'note' : /Websites[\\/]/.test(file) ? 'website' : 'file';
      pushDoc(file, path.basename(file).replace(/\.[^.]+$/, ''), kind, d.text, path.dirname(rel));
    }
    // Saved notes and tasks live in Jarvis's data folder.
    const readJSON = n => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, n), 'utf8')); } catch { return []; } };
    for (const n of readJSON('notes.json')) pushDoc(`note:${n.id}`, n.text.slice(0, 40), 'note', n.text, 'Notes');
    for (const t of readJSON('tasks.json')) pushDoc(`task:${t.id}`, t.text.slice(0, 40), 'task', `${t.text} ${t.due || ''} ${t.done ? 'done' : 'to do'}`, 'Tasks');
    if (s.userName || s.homeCity) pushDoc('me', s.userName || 'Me', 'person', `My name is ${s.userName}. I live in ${s.homeCity}. ${s.sttWords || ''}`, 'About me');

    const df = {};
    for (const d of docs) for (const w of Object.keys(d.tf)) df[w] = (df[w] || 0) + 1;
    index = { docs, df, avgLen: docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1), built: Date.now(), files: files.length };
    return index;
  }

  function ensure(maxAgeMs = 60_000) {
    if (!index || Date.now() - index.built > maxAgeMs) build();
    return index;
  }

  // BM25 search across everything.
  function search(query, limit = 6) {
    const ix = ensure();
    const q = [...new Set(words(query))];
    if (!q.length) return [];
    const N = ix.docs.length;
    const scored = [];
    for (const d of ix.docs) {
      let score = 0;
      for (const w of q) {
        const f = d.tf[w];
        if (!f) continue;
        const idf = Math.log(1 + (N - ix.df[w] + 0.5) / (ix.df[w] + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / ix.avgLen));
      }
      if (d.title && q.some(w => d.title.toLowerCase().includes(w))) score += 1.5;
      if (score > 0) scored.push({ d, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const out = [];
    for (const { d, score } of scored) {
      const key = d.id + ':' + d.chunk;
      if (seen.has(key)) continue;
      seen.add(key);
      // coverage: how much of the question this note covers (used by Reflex's "Vault has it").
      const coverage = q.filter(w => d.tf[w]).length / q.length;
      const titleHit = q.some(w => d.title.toLowerCase().includes(w));
      out.push({ title: d.title, kind: d.kind, where: d.folder, file: d.id.includes(path.sep) ? d.id : undefined, text: d.text.trim().slice(0, 900), score: +score.toFixed(2), coverage: +coverage.toFixed(2), titleHit });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Save a fact/note as a real Markdown file in the Brain folder.
  function remember(title, text, tags = []) {
    fs.mkdirSync(brainDir(), { recursive: true });
    const safe = String(title || 'Note').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 70) || 'Note';
    let file = path.join(brainDir(), safe + '.md');
    for (let n = 2; fs.existsSync(file); n++) file = path.join(brainDir(), `${safe} (${n}).md`);
    const tagLine = tags.length ? '\n\n' + tags.map(t => '#' + String(t).replace(/\s+/g, '-')).join(' ') : '';
    fs.writeFileSync(file, `# ${safe}\n\n${String(text).trim()}${tagLine}\n\n_Saved by Jarvis on ${new Date().toLocaleString()}_\n`, 'utf8');
    index = null; // re-index next time
    return file;
  }

  // The map: files/notes as nodes, linked to shared topics, folders, #tags and [[links]].
  function graph() {
    const ix = ensure();
    const byId = new Map();
    for (const d of ix.docs) {
      const g = byId.get(d.id) || { id: d.id, label: d.title, type: d.kind, folder: d.folder, tf: {}, text: '' };
      for (const [w, c] of Object.entries(d.tf)) g.tf[w] = (g.tf[w] || 0) + c;
      if (g.text.length < 4000) g.text += d.text;
      byId.set(d.id, g);
    }
    const docs = [...byId.values()];
    const N = docs.length || 1;
    const topicCount = {};
    for (const g of docs) {
      // A document's topics: its most distinctive words.
      g.topics = Object.entries(g.tf)
        .filter(([w]) => w.length > 3 && ix.df[w] >= 2 && ix.df[w] < N * 0.4)
        .map(([w, c]) => [w, c * Math.log(N / ix.df[w])])
        .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);
      for (const t of g.topics) topicCount[t] = (topicCount[t] || 0) + 1;
    }
    const nodes = [], links = [];
    const topics = Object.entries(topicCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 180);
    const topicSet = new Set(topics.map(([t]) => t));
    for (const [t, c] of topics) nodes.push({ id: 'topic:' + t, label: t, type: 'topic', weight: c });
    const folders = {};
    for (const g of docs) {
      nodes.push({ id: g.id, label: g.label, type: g.type, folder: g.folder });
      for (const t of g.topics) if (topicSet.has(t)) links.push({ s: g.id, t: 'topic:' + t });
      if (g.folder && g.type !== 'task') {
        folders[g.folder] = (folders[g.folder] || 0) + 1;
        links.push({ s: g.id, t: 'folder:' + g.folder });
      }
      for (const m of g.text.matchAll(/\[\[([^\]|#]+)/g)) {
        const target = docs.find(x => x.label.toLowerCase() === m[1].trim().toLowerCase());
        if (target) links.push({ s: g.id, t: target.id });
      }
      for (const m of g.text.matchAll(/(^|\s)#([a-z][\w-]{2,30})/gi)) {
        const tag = 'tag:' + m[2].toLowerCase();
        if (!nodes.some(n => n.id === tag)) nodes.push({ id: tag, label: '#' + m[2].toLowerCase(), type: 'tag' });
        links.push({ s: g.id, t: tag });
      }
    }
    for (const [f, c] of Object.entries(folders)) nodes.push({ id: 'folder:' + f, label: path.basename(f) || f, type: 'folder', weight: c });
    const deg = {};
    for (const l of links) { deg[l.s] = (deg[l.s] || 0) + 1; deg[l.t] = (deg[l.t] || 0) + 1; }
    for (const n of nodes) n.degree = deg[n.id] || 0;
    return { nodes, links, files: ix.files, built: ix.built };
  }

  // Inspector panel: a short preview of one node.
  function node(id) {
    const ix = ensure();
    if (id.startsWith('topic:') || id.startsWith('tag:')) {
      const word = id.split(':')[1].replace(/^#/, '');
      return { id, title: id.startsWith('tag:') ? '#' + word : word, type: id.split(':')[0], related: search(word, 8).map(r => r.title) };
    }
    if (id.startsWith('folder:')) return { id, title: id.slice(7), type: 'folder' };
    const chunks = ix.docs.filter(d => d.id === id);
    if (!chunks.length) return null;
    return { id, title: chunks[0].title, type: chunks[0].kind, where: chunks[0].folder, file: id.includes(path.sep) ? id : undefined, preview: chunks.map(c => c.text).join('').slice(0, 1500) };
  }

  return { search, remember, graph, node, rebuild: build, brainDir, sourceFolders };
}

module.exports = { createBrain };
