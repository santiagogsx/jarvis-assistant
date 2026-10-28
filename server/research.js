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

// ---------------------------------------------------------------- website analyzer
// "Reverse engineer" a site: which frameworks, 3D/animation libraries, hosting,
// fonts and colours it uses, from its HTML, headers and script bundles.
const TECH = [
  ['Three.js (3D / WebGL)', /three(\.module)?(\.min)?\.js|THREE\.WebGLRenderer|WebGLRenderer|three@\d/i],
  ['GSAP (animation)', /gsap|TweenMax|TweenLite|greensock/i],
  ['GSAP ScrollTrigger', /ScrollTrigger/],
  ['Lenis (smooth scrolling)', /lenis/i],
  ['Locomotive Scroll', /locomotive-scroll/i],
  ['Framer Motion', /framer-motion|motion\.div/i],
  ['Lottie animations', /lottie|bodymovin/i],
  ['Spline 3D', /spline(tool)?\.design|@splinetool/i],
  ['Rive animations', /rive\.app|@rive-app/i],
  ['PixiJS (2D WebGL)', /pixi(\.min)?\.js|PIXI\./],
  ['Babylon.js (3D)', /babylon(js)?/i],
  ['glTF 3D models (Draco/KTX2)', /DRACOLoader|KTX2Loader|\.glb\b|\.gltf\b/i],
  ['Post-processing effects', /EffectComposer|postprocessing|UnrealBloom|BloomEffect/],
  ['Custom shaders (GLSL)', /gl_FragColor|gl_Position|precision (highp|mediump) float/],
  ['React', /react-dom|__REACT_DEVTOOLS|data-reactroot|_reactRootContainer/i],
  ['Next.js', /\/_next\/|__NEXT_DATA__/],
  ['Vue', /vue(\.runtime)?(\.global)?(\.min)?\.js|data-v-[0-9a-f]{6,}|__VUE__/i],
  ['Nuxt', /\/_nuxt\/|__NUXT__/],
  ['Svelte / SvelteKit', /svelte|__sveltekit/i],
  ['Angular', /ng-version=|angular(\.min)?\.js/i],
  ['Astro', /astro-island|astro\/client/i],
  ['Gatsby', /___gatsby|gatsby-/i],
  ['Remix', /__remixContext/],
  ['jQuery', /jquery(\.min)?\.js|jQuery\.fn/i],
  ['Tailwind CSS', /tailwind|--tw-[a-z]/i],
  ['Bootstrap', /bootstrap(\.min)?\.(css|js)/i],
  ['Swiper (sliders)', /swiper/i],
  ['Barba.js (page transitions)', /barba/i],
  ['Webflow', /webflow\.js|data-wf-page/i],
  ['WordPress', /wp-content|wp-includes/i],
  ['Shopify', /cdn\.shopify\.com|Shopify\.theme/i],
  ['Wix', /wixstatic|_wixCssImports/i],
  ['Squarespace', /squarespace/i],
  ['Framer (site builder)', /framerusercontent|framer\.com\/m\//i],
  ['Google Analytics', /gtag\(|google-analytics\.com|googletagmanager/i],
  ['Stripe payments', /js\.stripe\.com/i],
  ['Vimeo / YouTube video', /player\.vimeo|youtube\.com\/embed/i],
];

async function analyzeWebsite(raw) {
  let url = await assertPublicUrl(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const html = (await res.text()).slice(0, 3_000_000);
  const base = new URL(res.url || url);
  const attr = (re) => [...html.matchAll(re)].map(m => { try { return new URL(m[1], base).href; } catch { return null; } }).filter(Boolean);
  const scripts = [...new Set(attr(/<script[^>]+src=["']([^"']+)["']/gi))];
  const styles = [...new Set(attr(/<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["']/gi))];
  // Look inside the site's script bundles too (that's where the libraries hide),
  // following files they load later (e.g. a separate "App3D" chunk), two levels deep.
  const site = base.hostname.replace(/^www\./, '');
  const isOurs = s => { try { const h = new URL(s).hostname; return h.endsWith(site) || /cdn|unpkg|jsdelivr|vercel|netlify|cloudfront/.test(h); } catch { return false; } };
  const preload = attr(/<link[^>]+rel=["']?modulepreload["']?[^>]*href=["']([^"']+)["']/gi);
  const inlineImports = [...html.matchAll(/import\(\s*["']([^"']+\.js)["']/g)].map(m => { try { return new URL(m[1], base).href; } catch { return null; } }).filter(Boolean);
  let queue = [...new Set([...scripts, ...preload, ...inlineImports])].filter(isOurs).map(u => ({ u, depth: 0 }));
  const seenJs = new Set();
  const chunkNames = [];
  let bundles = '', fetched = 0;
  while (queue.length && fetched < 18 && bundles.length < 9_000_000) {
    const { u, depth } = queue.shift();
    if (seenJs.has(u)) continue;
    seenJs.add(u);
    try {
      await assertPublicUrl(u);
      const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
      const js = (await r.text()).slice(0, 1_500_000);
      fetched++;
      bundles += '\n' + js;
      chunkNames.push(u.split('/').pop().split('?')[0]);
      if (depth < 2) {
        for (const m of js.matchAll(/["'`]((?:\.{1,2}\/|\/)[^"'`\s]{1,160}?\.js)["'`]/g)) {
          try { const next = new URL(m[1], u).href; if (isOurs(next) && !seenJs.has(next)) queue.push({ u: next, depth: depth + 1 }); } catch {}
        }
      }
    } catch {}
  }
  let css = '';
  for (const s of styles.slice(0, 4)) { try { await assertPublicUrl(s); css += (await (await fetch(s, { signal: AbortSignal.timeout(10000) })).text()).slice(0, 300_000); } catch {} }
  const everything = html + bundles + scripts.join(' ');
  const found = TECH.filter(([, re]) => re.test(everything)).map(([name]) => name);
  const ver = (bundles.match(/REVISION\s*=\s*["'](\d+)/) || [])[1];
  if (ver) found[found.findIndex(f => f.startsWith('Three.js'))] = `Three.js r${ver} (3D / WebGL)`;
  const headers = Object.fromEntries(['server', 'x-powered-by', 'x-vercel-id', 'x-nf-request-id', 'cf-ray', 'x-github-request-id'].map(h => [h, res.headers.get(h)]).filter(([, v]) => v));
  const hosting = headers['x-vercel-id'] ? 'Vercel' : headers['x-nf-request-id'] ? 'Netlify' : headers['cf-ray'] ? 'Cloudflare' : headers['x-github-request-id'] ? 'GitHub Pages' : headers.server || 'unknown';
  const fonts = [...new Set([...(html + css).matchAll(/family=([A-Za-z+]+)/g)].map(m => m[1].replace(/\+/g, ' ')).concat([...css.matchAll(/font-family:\s*["']?([^;,"'}]+)/g)].map(m => m[1].trim())))].slice(0, 8);
  const colors = Object.entries([...(html + css).matchAll(/#[0-9a-f]{6}\b/gi)].reduce((a, m) => { const c = m[0].toLowerCase(); a[c] = (a[c] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  const { title, text } = htmlToText(html);
  return {
    url: base.href, title, hosting, technology: found, headers,
    description: stripTags((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || ''),
    uses_webgl: /getContext\(["']webgl2?["']\)|WebGLRenderer/.test(everything),
    canvas_elements: (html.match(/<canvas/gi) || []).length,
    fonts, colors, script_count: scripts.length, code_files_checked: chunkNames.slice(0, 18),
    headings: [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => stripTags(m[1])).filter(Boolean).slice(0, 12),
    visible_text_sample: text.slice(0, 1200),
  };
}

module.exports = { webSearch, readWebpage, news, getJSON, stripTags, assertPublicUrl, analyzeWebsite };
