// Timezone-aware week math.
//
// The unit of work is a "week", identified by the date of its Friday in the
// household timezone (YYYY-MM-DD). The deadline is the end of that Friday --
// i.e. the instant Saturday begins. Everything the app does hangs off that
// single instant.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Intl renders midnight as hour 24 under hour12:false; normalise it.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

// Offset in ms between the given timezone and UTC at that instant.
function offsetAt(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// Convert a wall-clock time in `timeZone` to a real UTC instant.
// Refines once so DST transitions land on the correct side.
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const o1 = offsetAt(new Date(guess), timeZone);
  let ts = guess - o1;
  const o2 = offsetAt(new Date(ts), timeZone);
  if (o2 !== o1) ts = guess - o2;
  return new Date(ts);
}

export function localParts(date, timeZone) {
  return partsIn(date, timeZone);
}

function ymd({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysTo(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// The week `now` belongs to, keyed by that week's Friday.
//
// A week stays "current" until its grace period expires, not until Friday ends.
// Otherwise Saturday morning would roll to a fresh week and quietly forgive the
// miss -- which is exactly the failure mode this app exists to prevent. The
// overdue week keeps ownership through the weekend and only hands off once it
// has been resolved or the grace window closes.
export function weekKeyFor(now, timeZone, graceDays = 4) {
  const p = partsIn(now, timeZone);
  // Days back to the most recent Friday (weekday 5). Saturday -> 1, Sunday -> 2.
  const back = (p.weekday - 5 + 7) % 7;
  const friday = addDaysTo(p, -back);
  const key = ymd(friday);
  // Still inside the previous week's grace window? Then it is still that week.
  if (back > 0 && back <= graceDays) return key;
  if (back === 0) return key;
  // Past grace: the upcoming Friday owns the week.
  return ymd(addDaysTo(p, 7 - back));
}

// The upcoming (or current) Friday's key, ignoring grace periods.
export function upcomingFridayKey(now, timeZone) {
  const p = partsIn(now, timeZone);
  const forward = (5 - p.weekday + 7) % 7;
  return ymd(addDaysTo(p, forward));
}

// Deadline for a week = the instant Saturday starts (Friday 24:00 local).
export function deadlineFor(weekKey, timeZone) {
  const [y, m, d] = weekKey.split('-').map(Number);
  return zonedToUtc(y, m, d + 1, 0, 0, timeZone);
}

// Hours until the deadline. Negative once overdue.
export function hoursUntilDeadline(weekKey, timeZone, now = new Date()) {
  return (deadlineFor(weekKey, timeZone).getTime() - now.getTime()) / 3_600_000;
}

// Minutes elapsed since local midnight on the week's Friday. Negative before it.
export function minutesIntoFriday(weekKey, timeZone, now = new Date()) {
  const [y, m, d] = weekKey.split('-').map(Number);
  const start = zonedToUtc(y, m, d, 0, 0, timeZone);
  return (now.getTime() - start.getTime()) / 60_000;
}

// Render minutes-into-day as a 12-hour clock, e.g. 1215 -> "8:15 PM".
// The ladder stores its rungs as minutes past local midnight; this is the only
// place that turns one into something a person reads.
export function formatClock(minutesIntoDay) {
  const total = ((Math.round(minutesIntoDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return minute === 0
    ? `${h12} ${suffix}`
    : `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function formatWeekLabel(weekKey, timeZone) {
  const [y, m, d] = weekKey.split('-').map(Number);
  const friday = zonedToUtc(y, m, d, 12, 0, timeZone);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(friday);
}
