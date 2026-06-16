const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

// Set via: firebase functions:config:set ical.secret="YOUR_RANDOM_TOKEN"
// Then redeploy: firebase deploy --only functions
const FEED_SECRET = (functions.config().ical && functions.config().ical.secret) || '';

const DAY_ABBR = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function pad(n) { return String(n).padStart(2, '0'); }

function escapeIcal(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// iCal lines must not exceed 75 octets; fold with CRLF + space
function foldLine(line) {
  const out = [];
  while (line.length > 75) {
    out.push(line.slice(0, 75));
    line = ' ' + line.slice(75);
  }
  out.push(line);
  return out.join('\r\n');
}

function toIcalDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-');
  if (!timeStr) return `${y}${m}${d}`;
  const [h, min] = timeStr.split(':');
  // Floating local time (no Z) — Outlook interprets in the user's local timezone
  return `${y}${m}${d}T${pad(parseInt(h))}${pad(parseInt(min))}00`;
}

function buildRRule(rec) {
  if (!rec || rec.freq === 'none' || !rec.freq) return null;
  const parts = [`FREQ=${rec.freq.toUpperCase()}`];
  if (rec.interval && rec.interval > 1) parts.push(`INTERVAL=${rec.interval}`);
  if (rec.freq === 'weekly' && Array.isArray(rec.days) && rec.days.length > 0) {
    parts.push(`BYDAY=${rec.days.map(d => DAY_ABBR[d]).join(',')}`);
  }
  if (rec.endDate) {
    const [y, m, d] = rec.endDate.split('-');
    parts.push(`UNTIL=${y}${m}${d}T235959`);
  }
  return `RRULE:${parts.join(';')}`;
}

function eventToVEvent(ev) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${ev.id}@the-abyss-calendar`);

  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  lines.push(`DTSTAMP:${now}`);

  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`);
    // DTEND for all-day is exclusive (day after last)
    const last = ev.endDate || ev.date;
    const dt = new Date(last + 'T00:00:00');
    dt.setDate(dt.getDate() + 1);
    const ye = dt.getFullYear(), mo = pad(dt.getMonth() + 1), da = pad(dt.getDate());
    lines.push(`DTEND;VALUE=DATE:${ye}${mo}${da}`);
  } else {
    lines.push(`DTSTART:${toIcalDateTime(ev.date, ev.start)}`);
    const endDate = ev.endDate || ev.date;
    lines.push(`DTEND:${toIcalDateTime(endDate, ev.end || ev.start)}`);
  }

  lines.push(`SUMMARY:${escapeIcal(ev.title)}`);
  if (ev.desc) lines.push(`DESCRIPTION:${escapeIcal(ev.desc)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcal(ev.location)}`);

  const rrule = buildRRule(ev.recurrence);
  if (rrule) lines.push(rrule);

  if (ev.recurrence && Array.isArray(ev.recurrence.exceptions) && ev.recurrence.exceptions.length > 0) {
    const exdates = ev.recurrence.exceptions.map(d => d.replace(/-/g, '') + 'T000000');
    lines.push(`EXDATE:${exdates.join(',')}`);
  }

  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}

exports.icalFeed = functions.https.onRequest(async (req, res) => {
  // Reject if no secret is configured
  if (!FEED_SECRET) {
    res.status(503).send('Feed not configured. Set ical.secret via firebase functions:config:set.');
    return;
  }

  const token = req.query.token || '';
  if (token !== FEED_SECRET) {
    res.status(403).send('Forbidden');
    return;
  }

  try {
    const snapshot = await admin.database().ref('krakenEvents').once('value');
    const raw = snapshot.val();

    const vevents = [];
    const items = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
    for (const ev of items) {
      if (!ev || !ev.id || !ev.title || !ev.date) continue;
      vevents.push(eventToVEvent(ev));
    }

    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//The Abyss//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:The Abyss',
      'X-WR-CALDESC:The Abyss Team Calendar',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
      ...vevents,
      'END:VCALENDAR',
    ].join('\r\n');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="the-abyss.ics"');
    res.set('Cache-Control', 'no-cache, no-store');
    res.send(ical);
  } catch (err) {
    console.error('icalFeed error:', err);
    res.status(500).send('Internal Server Error');
  }
});
