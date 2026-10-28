// Calendar: reads the person's calendars through their private iCal (.ics)
// links (Google "secret address", iCloud public link, Outlook "publish"), and
// prepares new events for them to save (Google: pre-filled event page;
// others: an .ics file their calendar app opens). Read-only access, no passwords.
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = new Map(); // url -> { at, events }

// ---------------------------------------------------------------- iCal parsing
function unfold(text) { return text.replace(/\r?\n[ \t]/g, ''); }

// Wall-clock time in an IANA zone -> real Date.
function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz) return new Date(y, mo - 1, d, h, mi, s); // "floating" = local time
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return new Date(guess - (asTz - guess));
  } catch { return new Date(y, mo - 1, d, h, mi, s); }
}

function parseDate(value, params = '') {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  return { date: zoned(+y, +mo, +d, +h, +mi, +s, tz), allDay: false };
}

function parseICS(text) {
  const events = [];
  for (const block of unfold(text).split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const ev = { exdates: [] };
    for (const line of body.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...p] = line.slice(0, i).split(';');
      const params = p.join(';');
      const val = line.slice(i + 1).replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1');
      if (name === 'SUMMARY') ev.title = val;
      else if (name === 'LOCATION') ev.location = val;
      else if (name === 'DESCRIPTION') ev.notes = val.slice(0, 300);
      else if (name === 'DTSTART') ev.start = parseDate(val, params);
      else if (name === 'DTEND') ev.end = parseDate(val, params);
      else if (name === 'RRULE') ev.rrule = Object.fromEntries(val.split(';').map(kv => kv.split('=')));
      else if (name === 'EXDATE') for (const v of val.split(',')) { const d = parseDate(v, params); if (d) ev.exdates.push(+d.date); }
      else if (name === 'STATUS') ev.status = val;
      else if (name === 'RECURRENCE-ID') ev.recurrenceId = parseDate(val, params);
    }
    if (ev.start && ev.status !== 'CANCELLED') events.push(ev);
  }
  return events;
}

const DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Expand repeating events into the time window.
function expand(ev, from, to) {
  const start = ev.start.date;
  const dur = ev.end ? +ev.end.date - +start : (ev.start.allDay ? 86400000 : 3600000);
  const out = [];
  const push = d => { if (+d + dur > +from && +d < +to && !ev.exdates.includes(+d)) out.push({ ...ev, at: new Date(d), until: new Date(+d + dur) }); };
  if (!ev.rrule) { push(start); return out; }
  const r = ev.rrule, interval = Number(r.INTERVAL) || 1, count = Number(r.COUNT) || Infinity;
  const until = r.UNTIL ? parseDate(r.UNTIL).date : null;
  let n = 0, d = new Date(start);
  const byDays = r.BYDAY ? r.BYDAY.split(',').map(x => DAY[x.slice(-2)]).filter(x => x !== undefined) : null;
  for (let guard = 0; guard < 2000 && n < count && +d < +to && (!until || +d <= +until); guard++) {
    if (r.FREQ === 'WEEKLY' && byDays) {
      // Walk each day of this week that is listed in BYDAY.
      const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
      for (const wd of byDays.sort()) {
        const x = new Date(weekStart); x.setDate(weekStart.getDate() + wd); x.setHours(start.getHours(), start.getMinutes(), start.getSeconds());
        if (+x < +start || (until && +x > +until) || n >= count) continue;
        n++; push(x);
      }
      d.setDate(d.getDate() + 7 * interval);
      continue;
    }
    n++; push(new Date(d));
    if (r.FREQ === 'DAILY') d.setDate(d.getDate() + interval);
    else if (r.FREQ === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
    else if (r.FREQ === 'MONTHLY') d.setMonth(d.getMonth() + interval);
    else if (r.FREQ === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
    else break;
  }
  return out;
}

// ---------------------------------------------------------------- public API
function links(settings) {
  return String(settings.keys.calendar || '').split(/\s+/).map(s => s.trim().replace(/^webcal:\/\//i, 'https://')).filter(s => /^https:\/\//i.test(s));
}

async function fetchCalendar(url) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < 5 * 60000) return c.events;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'JarvisAssistant/1.0' } });
  if (!r.ok) throw new Error(r.status === 404 || r.status === 403 ? 'The calendar link no longer works. Copy it again in Settings → Calendar.' : `Calendar server error (${r.status}).`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link isn't a calendar (iCal) link. Use the secret iCal address from your calendar's settings.");
  const events = parseICS(text);
  cache.set(url, { at: Date.now(), events });
  return events;
}

function window_(range, dateStr) {
  const now = new Date();
  const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (dateStr) { const d = new Date(dateStr + 'T00:00:00'); if (!isNaN(d)) return [d, add(d, 1)]; }
  switch (range) {
    case 'tomorrow': return [add(day(now), 1), add(day(now), 2)];
    case 'this_week': { const s = day(now); return [s, add(s, 7 - s.getDay())]; }
    case 'next_7_days': return [day(now), add(day(now), 7)];
    case 'next_30_days': return [day(now), add(day(now), 30)];
    default: return [day(now), add(day(now), 1)];
  }
}

async function events(settings, { range = 'today', date } = {}) {
  const urls = links(settings);
  if (!urls.length) throw new Error('No calendar is connected yet. Connect it in Settings → Calendar (takes a minute).');
  const [from, to] = window_(range, date);
  const all = [];
  for (const u of urls) {
    const list = await fetchCalendar(u);
    // One-off changes to a repeating event replace that occurrence.
    const moved = new Set(list.filter(e => e.recurrenceId).map(e => (e.title || '') + +e.recurrenceId.date));
    for (const ev of list) for (const o of expand(ev, from, to)) {
      if (ev.rrule && moved.has((ev.title || '') + +o.at)) continue;
      all.push(o);
    }
  }
  all.sort((a, b) => a.at - b.at);
  const fmt = (d, allDay) => allDay ? 'all day' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    range: date || range,
    from: from.toDateString(),
    count: all.length,
    events: all.slice(0, 60).map(e => ({
      title: e.title || '(no title)', day: e.at.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }),
      time: fmt(e.at, e.start.allDay), ends: e.start.allDay ? undefined : fmt(e.until, false), location: e.location || undefined,
    })),
  };
}

// New event: Google -> its pre-filled "new event" page; others -> .ics file the calendar app opens.
function newEvent(settings, { title, start, end, details, location }) {
  const s = new Date(start);
  if (isNaN(s)) throw new Error('I need a start date and time, like 2026-10-30T18:00.');
  const e = end && !isNaN(new Date(end)) ? new Date(end) : new Date(+s + 3600000);
  const z = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  if ((settings.calendar?.kind || 'google') === 'google') {
    const q = new URLSearchParams({ action: 'TEMPLATE', text: title || 'Event', dates: `${z(s)}/${z(e)}`, details: details || '', location: location || '' });
    return { open_url: `https://calendar.google.com/calendar/render?${q}`, how: 'google' };
  }
  const esc = t => String(t || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis//EN', 'BEGIN:VEVENT', `UID:${Date.now()}@jarvis`, `DTSTAMP:${z(new Date())}`,
    `DTSTART:${z(s)}`, `DTEND:${z(e)}`, `SUMMARY:${esc(title)}`, details ? `DESCRIPTION:${esc(details)}` : '', location ? `LOCATION:${esc(location)}` : '', 'END:VEVENT', 'END:VCALENDAR']
    .filter(Boolean).join('\r\n');
  const file = path.join(os.tmpdir(), `jarvis-event-${Date.now()}.ics`);
  fs.writeFileSync(file, ics);
  return { file, how: 'ics' };
}

async function test(url) {
  cache.delete(url);
  const evs = await fetchCalendar(url.replace(/^webcal:\/\//i, 'https://'));
  return { ok: true, events: evs.length };
}

module.exports = { events, newEvent, test, parseICS, expand };
