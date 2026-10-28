// Texts and phone calls to the owner's own phone, through Twilio.
// Only the number saved in Settings can be texted or called, so nobody using
// Jarvis remotely can use it to message strangers.
const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function config(s) {
  const p = s.phone || {};
  if (!p.twilioSid || !s.keys.twilio || !p.twilioFrom || !p.myNumber) {
    throw new Error('Texting and calling are not set up. Add your Twilio details and your phone number in Settings → Phone.');
  }
  return { sid: p.twilioSid.trim(), token: s.keys.twilio, from: p.twilioFrom.trim(), to: p.myNumber.trim() };
}

async function twilio(c, resource, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/${resource}.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: c.to, From: c.from, ...params }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio: ${d.message || 'HTTP ' + res.status}`);
  return d;
}

async function textMe(s, message) {
  const c = config(s);
  const d = await twilio(c, 'Messages', { Body: String(message).slice(0, 1500) });
  return { ok: true, sent_to: c.to, id: d.sid };
}

async function callMe(s, message) {
  const c = config(s);
  const say = `<Say voice="Polly.Brian">${xmlEscape(String(message).slice(0, 1200))}</Say>`;
  const twiml = `<Response><Pause length="1"/>${say}<Pause length="2"/><Say voice="Polly.Brian">Repeating.</Say>${say}</Response>`;
  const d = await twilio(c, 'Calls', { Twiml: twiml });
  return { ok: true, calling: c.to, id: d.sid };
}

module.exports = { textMe, callMe, check: config };
