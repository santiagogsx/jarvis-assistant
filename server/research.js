// Online research: web search (Tavily or Brave if a key is set, otherwise
// DuckDuckGo with a Wikipedia fallback), reading web pages, and news headlines.
const dns = require('dns').promises;
const net = require('net');

const enc = encodeURIComponent;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 JarvisAssistant/1.0';

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const stripTags = s => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Block pages on the local network so people using Jarvis remotely can't use
// it to poke at the owner's router, printer, etc.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http/https links can be read.');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That address is on a private network and is blocked.');
  return url;
}

async function webSearch(query, settings, max = 6) {
  max = Math.min(Math.max(Number(max) || 6, 1), 10);
  const keys = settings.keys;

  if (keys.tavily) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.tavily}` },
      body: JSON.stringify({ query, max_results: max, include_answer: true, search_depth: 'advanced' }),
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) {
      const d = await r.json();
      return { engine: 'tavily', quick_answer: d.answer || undefined, results: (d.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 500) })) };
    }
  }

  if (keys.brave) {
    try {
      const d = await getJSON(`https://api.search.brave.com/res/v1/web/search?q=${enc(query)}&count=${max}`, { 'x-subscription-token': keys.brave, accept: 'application/json' });
      return { engine: 'brave', results: (d.web?.results || []).map(x => ({ title: stripTags(x.title), url: x.url, snippet: stripTags(x.description) })) };
    } catch {}
  }

  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${enc(query)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const results = [];
    for (const block of html.split('class="result__title"').slice(1)) {
      if (results.length >= max) break;
      const a = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let href = decodeEntities(a[1]);
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      if (/duckduckgo\.com\/y\.js/.test(href)) continue; // ads
      const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      results.push({ title: stripTags(a[2]), url: href, snippet: stripTags(snip && snip[1]) });
    }
    if (results.length) return { engine: 'duckduckgo', results };
  } catch {}

  // Last resort: Wikipedia.
  const w = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(query)}&format=json&srlimit=${max}`);
  const results = (w.query?.search || []).map(x => ({ title: x.title, url: `https://en.wikipedia.org/wiki/${enc(x.title.replace(/ /g, '_'))}`, snippet: stripTags(x.snippet) }));
  return { engine: 'wikipedia', results, note: results.length ? 'General web search was unavailable; these are Wikipedia results. Add a free Tavily or Brave key in Settings for better research.' : 'No results found.' };
}

function htmlToText(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  let body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = body.match(/<(article|main)[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 1500) body = main[0];
  const text = decodeEntities(
    body.replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title, text };
}

async function readWebpage(raw, maxChars = 10000) {
  let url = await assertPublicUrl(raw);
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    break;
  }
  if (!res.ok) return { url: url.href, error: `The site answered with HTTP ${res.status}.` };
  const type = res.headers.get('content-type') || '';
  if (!/text|html|json|xml/.test(type)) return { url: url.href, error: `That link is a ${type || 'binary file'}, which I can't read as text.` };
  const raw2 = (await res.text()).slice(0, 3_000_000);
  const { title, text } = /html/.test(type) ? htmlToText(raw2) : { title: '', text: raw2 };
  const limit = Math.min(Math.max(Number(maxChars) || 10000, 1000), 20000);
  return { url: url.href, title, text: text.slice(0, limit), truncated: text.length > limit };
}

async function news(topic, country = 'US') {
  const q = topic ? `search?q=${enc(topic)}&` : '?';
  const r = await fetch(`https://news.google.com/rss/${q}hl=en-${country}&gl=${country}&ceid=${country}:en`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map(m => {
    const pick = tag => decodeEntities((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '').trim();
    return { headline: pick('title'), source: pick('source'), published: pick('pubDate'), link: pick('link') };
  });
  return { topic: topic || 'top stories', headlines: items };
}

module.exports = { webSearch, readWebpage, news, getJSON, stripTags, assertPublicUrl };
