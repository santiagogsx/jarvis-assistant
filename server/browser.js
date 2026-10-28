// Live research in a real, visible browser window on the main computer
// (Chrome, Edge or Brave), so the person can watch Jarvis work. It uses its
// own profile: the person's normal browser, history and passwords are never
// touched. Jarvis never types into password fields.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BRAVE_PATHS = {
  win32: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ],
  darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/brave-browser', '/usr/bin/brave'],
};

const NAMES = { chrome: 'Chrome', msedge: 'Edge', brave: 'Brave' };

// Glowing outline so the person can see what is about to be clicked/typed into.
const HIGHLIGHT = el => {
  const prev = el.style.outline, prevShadow = el.style.boxShadow;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.style.outline = '3px solid #5fe3ff';
  el.style.boxShadow = '0 0 18px 6px rgba(95,227,255,.75)';
  setTimeout(() => { el.style.outline = prev; el.style.boxShadow = prevShadow; }, 1400);
};

function createBrowser(dataDir, getSettings, onStep) {
  let context = null, page = null, using = '';

  async function launch(kind) {
    const opts = { headless: false, viewport: null, args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'] };
    if (kind === 'brave') {
      const exe = (BRAVE_PATHS[process.platform] || []).find(p => p && fs.existsSync(p));
      if (!exe) throw new Error('Brave is not installed');
      opts.executablePath = exe;
    } else {
      opts.channel = kind;
    }
    return chromium.launchPersistentContext(path.join(dataDir, 'browser-profile-' + kind), opts);
  }

  async function ensure() {
    if (page && !page.isClosed()) return page;
    if (context) {
      page = context.pages().find(p => !p.isClosed()) || await context.newPage();
      return page;
    }
    const pref = getSettings().browser || 'auto';
    const order = pref === 'auto' ? ['chrome', 'msedge', 'brave'] : [pref];
    for (const kind of order) {
      try {
        context = await launch(kind);
        using = kind;
        context.on('close', () => { context = null; page = null; });
        // Links that open a new tab: follow Jarvis to it.
        context.on('page', p => { page = p; });
        page = context.pages()[0] || await context.newPage();
        return page;
      } catch {}
    }
    throw new Error(pref === 'auto'
      ? 'I could not open Chrome, Edge or Brave on this computer. Install one of them, then try again.'
      : `I could not open ${NAMES[pref] || pref}. Is it installed? You can pick another browser in Settings → AI.`);
  }

  const step = text => onStep?.(text);

  async function settle(p) {
    await p.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(700);
  }

  // What the AI "sees": title, URL, readable text and the visible links.
  async function look(p, maxChars = 7000) {
    const data = await p.evaluate(max => {
      const root = document.querySelector('main, article, [role=main]') || document.body;
      const text = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      const links = [...document.querySelectorAll('a[href]')]
        .filter(a => a.offsetParent && a.innerText.trim().length > 2 && /^https?:/.test(a.href))
        .slice(0, 40)
        .map(a => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 90), url: a.href }));
      return { text: text.slice(0, max), truncated: text.length > max, links };
    }, maxChars).catch(() => ({ text: '', links: [] }));
    return { browser: NAMES[using] || using, url: p.url(), title: await p.title().catch(() => ''), ...data };
  }

  async function open(url) {
    const p = await ensure();
    const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    step(`Opening ${new URL(u).hostname}…`);
    await p.bringToFront();
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(p);
    return look(p);
  }

  async function search(query) {
    const p = await ensure();
    await p.bringToFront();
    step(`Searching Google for "${query}"…`);
    await p.goto('https://www.google.com/search?q=' + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(p);
    // Google sometimes asks robots to prove they're human; switch to Bing instead of fighting it.
    if (/\/sorry\//.test(p.url()) || /unusual traffic/i.test(await p.content().catch(() => ''))) {
      step(`Google wants a check; searching Bing instead…`);
      await p.goto('https://www.bing.com/search?q=' + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(p);
    }
    const results = await p.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const h of document.querySelectorAll('a h3, li.b_algo h2 a, h2 a')) {
        const a = h.closest('a') || h;
        const url = a.href;
        // Skip the search engine's own links and ads.
        if (!url || seen.has(url) || !/^https?:/.test(url) || /google\.|bing\.com\/(search|aclk)|doubleclick|googleadservices/.test(new URL(url).hostname + new URL(url).pathname)) continue;
        if (a.closest('.b_ad, [data-text-ad], #tads, #bottomads')) continue;
        seen.add(url);
        const box = a.closest('div.g, li.b_algo, div[data-hveid]') || a.parentElement;
        out.push({ title: h.innerText.trim(), url, snippet: (box?.innerText || '').replace(h.innerText, '').replace(/\s+/g, ' ').trim().slice(0, 220) });
        if (out.length >= 8) break;
      }
      return out;
    }).catch(() => []);
    return { browser: NAMES[using] || using, url: p.url(), query, results };
  }

  async function click(target) {
    const p = await ensure();
    await p.bringToFront();
    const t = String(target || '').trim();
    if (!t) return { error: 'Say what to click (its text, or a URL from the page).' };
    if (/^https?:\/\//i.test(t)) return open(t);
    const candidates = [
      p.getByRole('link', { name: t }), p.getByRole('button', { name: t }),
      p.getByText(t, { exact: false }),
    ];
    for (const loc of candidates) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) {
        step(`Clicking "${t.slice(0, 60)}"…`);
        await el.evaluate(HIGHLIGHT).catch(() => {});
        await p.waitForTimeout(650);
        await el.click({ timeout: 8000 }).catch(() => el.click({ timeout: 8000, force: true }));
        await p.waitForTimeout(400);
        const now = page && !page.isClosed() ? page : p; // a new tab may have opened
        await now.bringToFront().catch(() => {});
        await settle(now);
        return look(now);
      }
    }
    return { error: `I couldn't find "${t}" on the page.`, ...(await look(p, 1500)) };
  }

  async function type(field, text, submit) {
    const p = await ensure();
    await p.bringToFront();
    let el = null;
    if (field) {
      for (const loc of [p.getByPlaceholder(field), p.getByLabel(field), p.getByRole('searchbox', { name: field }), p.getByRole('textbox', { name: field })]) {
        if (await loc.first().isVisible().catch(() => false)) { el = loc.first(); break; }
      }
    }
    if (!el) {
      const loc = p.locator('input[type=search], input[type=text], input:not([type]), textarea').filter({ visible: true });
      if (await loc.first().isVisible().catch(() => false)) el = loc.first();
    }
    if (!el) return { error: 'There is no text box to type into on this page.' };
    const kind = await el.evaluate(e => (e.getAttribute('type') || '').toLowerCase() + ' ' + (e.autocomplete || '')).catch(() => '');
    if (/password|cc-|card/.test(kind)) return { error: 'That is a password or payment box. For your safety I leave those to you.' };
    step(`Typing "${String(text).slice(0, 50)}"…`);
    await el.evaluate(HIGHLIGHT).catch(() => {});
    await el.fill('');
    await el.pressSequentially(String(text), { delay: 25 });
    if (submit) { await el.press('Enter'); await settle(p); }
    return look(p);
  }

  async function scroll(direction = 'down') {
    const p = await ensure();
    step(`Scrolling ${direction}…`);
    await p.mouse.wheel(0, direction === 'up' ? -900 : 900);
    await p.waitForTimeout(600);
    return look(p);
  }

  async function back() {
    const p = await ensure();
    step('Going back…');
    await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await settle(p);
    return look(p);
  }

  async function read() {
    const p = await ensure();
    step('Reading the page…');
    return look(p, 12000);
  }

  // ---- Apple Music web player (the person signs in once in this browser; Jarvis never sees the password)
  async function appleMusicSignIn() {
    const p = await ensure();
    await p.bringToFront();
    step('Opening Apple Music: sign in with your Apple ID in the browser window…');
    await p.goto('https://music.apple.com/us/browse', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Bring up Apple's own sign-in box if it's there.
    const btn = p.getByRole('button', { name: /sign in/i }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    return { ok: true };
  }

  async function appleMusicSignedIn() {
    if (!context) return null;
    const cookies = await context.cookies('https://music.apple.com').catch(() => []);
    return cookies.some(c => c.name === 'media-user-token' && c.value);
  }

  async function appleMusicPlay(query) {
    const p = await ensure();
    await p.bringToFront();
    step(`Searching Apple Music for "${String(query).slice(0, 60)}"…`);
    await p.goto(`https://music.apple.com/us/search?term=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(2500);
    // Apple's page changes now and then, so try a few ways to find the first Play button.
    const selectors = [
      '[data-testid="top-search-result"] button[aria-label^="Play" i]',
      'button[data-testid="play-button"]',
      '[data-testid="track-lockup"] button[aria-label^="Play" i]',
      'main button[aria-label^="Play" i]',
    ];
    for (const sel of selectors) {
      const b = p.locator(sel).first();
      if (await b.count().catch(() => 0)) {
        await b.scrollIntoViewIfNeeded().catch(() => {});
        await b.locator('xpath=..').hover().catch(() => {});
        await b.evaluate(HIGHLIGHT).catch(() => {});
        step('Pressing play…');
        await b.click({ timeout: 6000, force: true }).catch(() => {});
        await p.waitForTimeout(2500);
        const title = await p.locator('[data-testid="lcd"] , .lcd-meta, [class*="lcd"]').first().innerText().catch(() => '');
        return { ok: true, playing: title.replace(/\s+/g, ' ').trim() || query, note: 'Playing in the Apple Music web player.' };
      }
    }
    return { ok: false, note: 'Apple Music search is open in the browser; tap play on the song you want.' };
  }

  async function close() {
    if (context) await context.close().catch(() => {});
    context = null;
    page = null;
    return { ok: true };
  }

  return { open, search, click, type, scroll, back, read, close, appleMusicSignIn, appleMusicSignedIn, appleMusicPlay };
}

module.exports = { createBrowser };
