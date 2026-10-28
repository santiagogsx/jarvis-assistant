// Email over IMAP (reading) and SMTP (sending). Works with any provider that
// supports IMAP with an app password: Gmail, Yahoo, iCloud, AOL, Zoho, Fastmail,
// most work/school and web-host mailboxes. Jarvis never sends on its own:
// it makes a draft and the person presses Send in the app.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const PRESETS = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  aol: { imapHost: 'imap.aol.com', imapPort: 993, smtpHost: 'smtp.aol.com', smtpPort: 465 },
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993, smtpHost: 'smtp.zoho.com', smtpPort: 465 },
};

function config(settings) {
  const e = settings.email || {};
  const pass = settings.keys.email;
  if (!e.user || !pass) throw new Error('No email account is connected. Add your email and app password in Settings → Email.');
  return { ...e, ...(PRESETS[e.preset] || {}), ...(e.preset === 'custom' ? e : {}), pass };
}

async function withMailbox(settings, folder, fn) {
  const c = config(settings);
  const client = new ImapFlow({
    host: c.imapHost, port: Number(c.imapPort) || 993, secure: true,
    auth: { user: c.user, pass: c.pass }, logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Couldn't sign in to ${c.imapHost}: ${e.responseText || e.message}. Check the email and app password in Settings.`);
  }
  const lock = await client.getMailboxLock(folder || 'INBOX');
  try {
    return await fn(client, c);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function summarize(client, uids) {
  if (!uids.length) return [];
  const out = [];
  for await (const m of client.fetch(uids, { envelope: true, flags: true, uid: true, internalDate: true }, { uid: true })) {
    const from = m.envelope.from?.[0];
    out.push({
      id: m.uid,
      from: from ? (from.name ? `${from.name} <${from.address}>` : from.address) : 'unknown',
      subject: m.envelope.subject || '(no subject)',
      date: (m.envelope.date || m.internalDate)?.toLocaleString(),
      unread: !m.flags.has('\\Seen'),
      _t: +(m.envelope.date || m.internalDate || 0),
    });
  }
  return out.sort((a, b) => b._t - a._t).map(({ _t, ...rest }) => rest);
}

async function listEmails(settings, { unread_only = true, limit = 10, folder = 'INBOX' } = {}) {
  limit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  return withMailbox(settings, folder, async client => {
    const uids = (await client.search(unread_only ? { seen: false } : { all: true }, { uid: true })) || [];
    const emails = await summarize(client, uids.slice(-limit));
    return { folder, unread_only, total_matching: uids.length, emails };
  });
}

async function searchEmails(settings, { query, limit = 10, folder = 'INBOX' } = {}) {
  if (!query) return { error: 'What should I search for?' };
  limit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  return withMailbox(settings, folder, async (client, c) => {
    // Gmail understands its own search syntax (from:, has:attachment, newer_than:7d ...).
    const criteria = /gmail/.test(c.imapHost)
      ? { gmraw: query }
      : { or: [{ subject: query }, { from: query }, { body: query }] };
    const uids = (await client.search(criteria, { uid: true })) || [];
    return { query, total_matching: uids.length, emails: await summarize(client, uids.slice(-limit)) };
  });
}

async function readEmail(settings, { id, folder = 'INBOX' } = {}) {
  if (!id) return { error: 'Which email? Give its id from the list.' };
  return withMailbox(settings, folder, async client => {
    const msg = await client.fetchOne(String(id), { source: true, uid: true }, { uid: true });
    if (!msg) return { error: `No email with id ${id}.` };
    const p = await simpleParser(msg.source);
    const text = (p.text || (p.html ? p.html.replace(/<[^>]+>/g, ' ') : '')).replace(/\n{3,}/g, '\n\n').trim();
    return {
      id: Number(id),
      from: p.from?.text, to: p.to?.text, cc: p.cc?.text,
      subject: p.subject, date: p.date?.toLocaleString(),
      message_id: p.messageId,
      attachments: (p.attachments || []).map(a => a.filename).filter(Boolean),
      body: text.slice(0, 6000), truncated: text.length > 6000,
    };
  });
}

async function sendEmail(settings, { to, cc, subject, body, inReplyTo }) {
  const c = config(settings);
  if (!to || !/@/.test(to)) throw new Error('The draft needs a valid "to" address.');
  const port = Number(c.smtpPort) || 465;
  const transport = nodemailer.createTransport({ host: c.smtpHost, port, secure: port === 465, auth: { user: c.user, pass: c.pass } });
  const info = await transport.sendMail({
    from: c.user, to, cc: cc || undefined, subject: subject || '', text: body || '',
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
  return { ok: true, messageId: info.messageId };
}

// ---------------------------------------------------------------- easy setup
// Type an email address -> we work out the provider, its server settings and
// the exact page where the person makes an app password for Jarvis.
const GUIDES = {
  gmail: {
    name: 'Gmail', url: 'https://myaccount.google.com/apppasswords', button: 'Open Google app passwords',
    before: { text: 'App passwords need 2-Step Verification. If Google says the page isn\'t available, turn it on first:', url: 'https://myaccount.google.com/signinoptions/twosv', button: 'Turn on 2-Step Verification' },
    steps: ['Sign in to your Google account if it asks.', 'Type the name Jarvis and press Create.', 'Copy the 16-letter password Google shows you.'],
  },
  yahoo: {
    name: 'Yahoo Mail', url: 'https://login.yahoo.com/account/security/app-passwords', button: 'Open Yahoo app passwords',
    steps: ['Sign in to Yahoo if it asks.', 'Click "Generate app password" (or "Get started"), name it Jarvis.', 'Copy the password Yahoo shows you.'],
  },
  aol: {
    name: 'AOL Mail', url: 'https://login.aol.com/account/security/app-passwords', button: 'Open AOL app passwords',
    steps: ['Sign in to AOL if it asks.', 'Click "Generate app password", name it Jarvis.', 'Copy the password AOL shows you.'],
  },
  icloud: {
    name: 'iCloud Mail', url: 'https://account.apple.com/account/manage/section/security', button: 'Open Apple ID security',
    steps: ['Sign in with your Apple ID.', 'Click "App-Specific Passwords", then the + button, and name it Jarvis.', 'Copy the password Apple shows you (it looks like xxxx-xxxx-xxxx-xxxx).'],
  },
  zoho: {
    name: 'Zoho Mail', url: 'https://accounts.zoho.com/home#security/app_password', button: 'Open Zoho app passwords',
    steps: ['Sign in to Zoho.', 'Click "Generate New Password", name it Jarvis.', 'Copy the password Zoho shows you.'],
  },
  outlook: {
    name: 'Outlook / Hotmail', oauthOnly: true,
    note: 'Microsoft no longer lets apps use passwords for Outlook.com, Hotmail and Live email. Connecting it needs Microsoft sign-in, which is coming in a future update. Meanwhile you can forward your Outlook mail to a Gmail account and connect that.',
  },
  custom: {
    name: 'Your email', url: '', button: '',
    steps: ['Use your normal email password, or an "app password" if your email provider offers them (look in its security settings).'],
  },
};

const DOMAINS = [
  [/^(gmail|googlemail)\.com$/, 'gmail'],
  [/^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/, 'yahoo'],
  [/^(aol\.com|aim\.com)$/, 'aol'],
  [/^(icloud\.com|me\.com|mac\.com)$/, 'icloud'],
  [/^(zoho\.com|zohomail\.com)$/, 'zoho'],
  [/^(outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com)$/, 'outlook'],
];

async function detect(address) {
  const email = String(address || '').trim().toLowerCase();
  const domain = email.split('@')[1];
  if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Type your full email address, like name@gmail.com.');
  let preset = (DOMAINS.find(([re]) => re.test(domain)) || [])[1];
  let servers = preset ? PRESETS[preset] : null;

  if (!preset) {
    // Custom domain: Google Workspace / Microsoft 365 are spotted by their mail servers.
    const mx = await require('dns').promises.resolveMx(domain).catch(() => []);
    const hosts = mx.map(m => m.exchange.toLowerCase()).join(' ');
    if (/google(mail)?\.com/.test(hosts)) { preset = 'gmail'; servers = PRESETS.gmail; }
    else if (/outlook\.com|office365/.test(hosts)) preset = 'outlook';
  }
  if (!preset) {
    // Anything else: Thunderbird's public settings directory knows most providers.
    try {
      const r = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const xml = await r.text();
        const block = tag => (xml.match(new RegExp(`<${tag}[^>]*type="(imap|smtp)"[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[2] || '';
        const val = (b, t) => (b.match(new RegExp(`<${t}>([^<]+)</${t}>`)) || [])[1];
        const inc = block('incomingServer'), out = block('outgoingServer');
        if (val(inc, 'hostname')) servers = { imapHost: val(inc, 'hostname'), imapPort: Number(val(inc, 'port')) || 993, smtpHost: val(out, 'hostname'), smtpPort: Number(val(out, 'port')) || 465 };
      }
    } catch {}
    preset = 'custom';
    servers ||= { imapHost: `imap.${domain}`, imapPort: 993, smtpHost: `smtp.${domain}`, smtpPort: 465 };
  }
  return { email, preset, ...(servers || {}), guide: GUIDES[preset] };
}

// Sign in to check the password really works, before saving anything.
async function testLogin({ email, password, imapHost, imapPort, smtpHost, smtpPort }) {
  const client = new ImapFlow({ host: imapHost, port: Number(imapPort) || 993, secure: true, auth: { user: email, pass: password }, logger: false });
  try {
    await client.connect();
    await client.logout().catch(() => {});
  } catch (e) {
    const why = String(e.responseText || e.message || '');
    if (/auth|credential|password|login|invalid/i.test(why)) throw new Error('Your email provider said the password is wrong. Make sure you pasted the app password (not your normal password), with nothing missing.');
    throw new Error(`Couldn't reach the mail server (${imapHost}). Check the internet connection, or the server settings under "Advanced".`);
  }
  // Sending is checked too, but a failure here doesn't stop reading email.
  try {
    const port = Number(smtpPort) || 465;
    await nodemailer.createTransport({ host: smtpHost, port, secure: port === 465, auth: { user: email, pass: password } }).verify();
    return { ok: true, canSend: true };
  } catch {
    return { ok: true, canSend: false };
  }
}

module.exports = { listEmails, searchEmails, readEmail, sendEmail, PRESETS, detect, testLogin };
