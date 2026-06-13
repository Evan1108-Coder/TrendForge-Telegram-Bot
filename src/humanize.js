// Turn machine-speak into plain language so the bot "talks like a person".
//
// The worst offender was /schedules printing raw cron and internal ids, e.g.
//   🟢 default-report — Daily at 06:00 [0 6 * * *]
// which means nothing to a normal user. humanizeCron() converts a cron
// expression into something like "every day at 6:00 AM", and describeSchedule()
// produces a full friendly line.

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 24h -> "6:00 AM" / "12:30 PM"
function formatTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Join a list naturally: [a] -> "a", [a,b] -> "a and b", [a,b,c] -> "a, b and c"
function naturalList(items) {
  const a = items.filter((x) => x !== '' && x != null);
  if (a.length === 0) return '';
  if (a.length === 1) return String(a[0]);
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// Describe an hour/minute field pair that may itself be a "*/n" step or a list.
function describeDays(dowField) {
  if (dowField === '*' || dowField === '?') return null; // every day
  // step like */2 is unusual for dow; treat lists / ranges / singles.
  const parts = dowField.split(',');
  const names = [];
  for (const p of parts) {
    if (p.includes('-')) {
      const [a, b] = p.split('-').map((n) => parseInt(n, 10));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        names.push(`${DOW_SHORT[a] || a}–${DOW_SHORT[b] || b}`);
        continue;
      }
    }
    const n = parseInt(p, 10);
    if (Number.isFinite(n)) names.push(DOW[n % 7]);
    else names.push(p);
  }
  return naturalList(names);
}

function describeMonths(monField) {
  if (monField === '*') return null;
  const parts = monField.split(',');
  const names = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && MONTHS[n]) names.push(MONTHS[n]);
    else names.push(p);
  }
  return naturalList(names);
}

function describeDom(domField) {
  if (domField === '*' || domField === '?') return null;
  const parts = domField.split(',');
  const segs = [];
  for (const p of parts) {
    if (p.includes('-')) {
      const [a, b] = p.split('-');
      segs.push(`${a}–${b}`);
    } else {
      segs.push(p);
    }
  }
  return naturalList(segs);
}

// Convert a 5-field cron string into a human sentence. Best-effort: handles the
// patterns this bot actually generates (daily, weekly, hourly steps, day-of-month
// ranges, specific months) and degrades gracefully for anything exotic.
function humanizeCron(expr) {
  if (!expr || typeof expr !== 'string') return 'on a custom schedule';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `on a custom schedule (${expr})`;

  const [min, hour, dom, mon, dow] = fields;

  // Every-N-minutes / every-N-hours steps.
  if (hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const n = hour.slice(2);
    return min === '0' ? `every ${n} hours` : `every ${n} hours (at :${String(min).padStart(2, '0')})`;
  }
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${min.slice(2)} minutes`;
  }
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'every minute';
  }

  // A concrete clock time (single minute + single hour) is by far the common case.
  const singleTime = /^\d+$/.test(min) && /^\d+$/.test(hour);
  const time = singleTime ? formatTime(hour, min) : null;
  const atTime = time ? `at ${time}` : null;

  const domDesc = describeDom(dom);
  const monDesc = describeMonths(mon);
  const dowDesc = describeDays(dow);

  const when = [];
  if (dowDesc) {
    // "every Monday", "every Mon–Fri"
    when.push(`every ${dowDesc}`);
  } else if (domDesc) {
    when.push(monDesc ? `on day ${domDesc}` : `on the ${domDesc}${ordinalSuffixHint(domDesc)} of the month`);
  } else if (!monDesc) {
    when.push('every day');
  }
  if (monDesc) when.push(`in ${monDesc}`);

  const whenStr = when.join(' ');
  if (atTime && whenStr) return `${whenStr} ${atTime}`.replace(/\s+/g, ' ').trim();
  if (atTime) return `every day ${atTime}`;
  if (whenStr) return whenStr;
  return `on a custom schedule (${expr})`;
}

// Tiny helper: only add an ordinal hint for a single bare day number.
function ordinalSuffixHint(domDesc) {
  if (/^\d+$/.test(domDesc)) {
    const n = parseInt(domDesc, 10);
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }
  return '';
}

// Friendly one-liner for a schedule object from listSchedules().
// e.g. { name:'default-report', cron:'0 6 * * *', enabled:true, source:'preferences' }
//   -> "✅ Your daily trend report — every day at 6:00 AM"
function describeSchedule(sched) {
  const on = sched.enabled !== false;
  const dot = on ? '✅' : '⏸️';
  const when = humanizeCron(sched.cron);
  let title;
  if (sched.source === 'preferences' || sched.name === 'default-report') {
    title = 'Your daily trend report';
  } else if (sched.description && sched.description !== sched.name) {
    title = sched.description;
  } else {
    // Turn an id like "daily-evening" into "Daily evening".
    title = String(sched.name || 'Schedule').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const state = on ? when : `${when} (paused)`;
  return `${dot} ${title} — ${state}`;
}

module.exports = { humanizeCron, formatTime, describeSchedule, naturalList };
