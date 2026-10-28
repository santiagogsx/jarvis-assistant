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

module.exports = { listEmails, searchEmails, readEmail, sendEmail, PRESETS };
