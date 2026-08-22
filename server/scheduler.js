import db, {
  setting,
  settingInt,
  settingBool,
  ensureWeek,
  getWeek,
  logEvent,
  currentStreak,
  getHolidayCache,
  setHolidayCache,
} from './db.js';
import { ensureCache, resolveHoliday } from '../lib/holidays.js';
import { sendTo } from './push.js';
import {
  weekKeyFor,
  hoursUntilDeadline,
  minutesIntoDueDay,
  formatWeekLabel,
  localParts,
} from '../lib/week.js';
import { decide } from '../lib/escalation.js';

function config() {
  return {
    timezone: setting('timezone'),
    graceDays: settingInt('grace_days'),
    siegeInterval: settingInt('siege_interval_minutes'),
    weekendInterval: settingInt('weekend_interval_minutes'),
    quietStart: settingInt('quiet_start_hour'),
    quietEnd: settingInt('quiet_end_hour'),
    holidayCountry: setting('holiday_country'),
    holidayHandling: setting('holiday_handling'),
  };
}

function minutesSince(iso, now) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}

function markMissed(weekKey, now) {
  const streakLost = currentStreak();
  db.prepare(
    "UPDATE weeks SET status = 'missed', missed_at = ?, on_time = 0, streak_lost = ? WHERE week_key = ?"
  ).run(now.toISOString(), streakLost, weekKey);
  logEvent(weekKey, 'missed', `streak lost: ${streakLost}`);

  if (settingBool('stakes_enabled')) {
    const amount = Number(setting('stakes_amount'));
    db.prepare(
      `INSERT INTO stakes (week_key, amount, status, created_at) VALUES (?, ?, 'owed', ?)
       ON CONFLICT(week_key) DO NOTHING`
    ).run(weekKey, amount, now.toISOString());
    logEvent(weekKey, 'stakes_owed', String(amount));
  }

  return streakLost;
}

async function notifyPartnerOfMiss(weekKey, streakLost, cfg) {
  const owner = setting('owner_name');
  const label = formatWeekLabel(weekKey, cfg.timezone);
  await sendTo(
    'partner',
    {
      tag: `miss-${weekKey}`,
      title: `${owner} missed the ${label} timesheet`,
      body:
        streakLost > 0
          ? `Friday closed unsubmitted. A ${streakLost}-week streak just ended.`
          : 'Friday closed unsubmitted. Worth a nudge in person.',
      urgency: 'high',
      requireInteraction: false,
      url: '/partner',
    },
    weekKey
  );
}

async function fire(weekKey, stage, now, cfg, { isFixedRung = false } = {}) {
  const url = setting('timesheet_url') || '/';
  const delivered = await sendTo(
    'owner',
    {
      tag: `timesheet-${weekKey}`,
      renotify: true,
      title: stage.title,
      body: stage.body,
      urgency: stage.urgency,
      requireInteraction: stage.requireInteraction,
      stage: stage.id,
      weekKey,
      url,
    },
    weekKey
  );

  db.prepare(
    'UPDATE weeks SET last_nudge = ?, nudge_count = nudge_count + 1, stage = ? WHERE week_key = ?'
  ).run(now.toISOString(), stage.id, weekKey);
  if (isFixedRung) {
    db.prepare('UPDATE weeks SET fixed_stage = ? WHERE week_key = ?').run(stage.id, weekKey);
  }
  logEvent(weekKey, 'nudge', `${stage.id} -> ${delivered} device(s)`);
}

// Close out any week that fell off the end of its grace window while still
// pending. The tick only ever looks at the current week, so without this an
// abandoned one stays `pending` forever -- and because the streak functions
// skip pending weeks, the miss is silently forgiven.
//
// Swept weeks are recorded but never announced: a push about a three-week-old
// Friday is noise. Rate-limited to once an hour, because the condition it
// looks for changes at most once a week.
let lastSweep = 0;

function sweepAbandoned(currentKey, cfg, now) {
  if (now.getTime() - lastSweep < 3_600_000) return 0;
  lastSweep = now.getTime();
  const stale = db
    .prepare("SELECT week_key FROM weeks WHERE status = 'pending' AND week_key != ?")
    .all(currentKey)
    .filter((w) => hoursUntilDeadline(w.week_key, cfg.timezone, now) <= 0);

  for (const { week_key: key } of stale) {
    db.prepare(
      `UPDATE weeks SET status = 'missed', missed_at = ?, on_time = 0,
       streak_lost = 0, missed_announced_at = ? WHERE week_key = ? AND status = 'pending'`
    ).run(now.toISOString(), now.toISOString(), key);
    // Deliberately no stake. A swept week is one the app never actually
    // nudged her about -- downtime, a fresh deploy, leftover dry runs -- and
    // billing for silence would make money appear out of nowhere.
    logEvent(key, 'missed_swept', 'no stake charged');
  }
  return stale.length;
}

// One pass of the loop. Exported so tests and the simulator can drive it.
export async function tick(now = new Date()) {
  const cfg = config();
  const weekKey = weekKeyFor(now, cfg.timezone, cfg.graceDays);
  ensureWeek(weekKey);
  sweepAbandoned(weekKey, cfg, now);

  const cache = await ensureCache({
    get: async () => getHolidayCache(),
    set: async (c) => setHolidayCache(c),
    country: cfg.holidayCountry,
    now: now.getTime(),
  });
  const holiday = resolveHoliday({ weekKey, cache, handling: cfg.holidayHandling });

  // Record what the holiday meant for this week, so history stays truthful
  // even if the setting changes later.
  db.prepare('UPDATE weeks SET holiday_name = ?, due_shift = ? WHERE week_key = ?').run(
    holiday.name,
    holiday.shiftDays,
    weekKey
  );
  const week = getWeek(weekKey);

  const hoursLeft = hoursUntilDeadline(weekKey, cfg.timezone, now, holiday.shiftDays);
  const minutes = minutesIntoDueDay(weekKey, cfg.timezone, now, holiday.shiftDays);
  const minutesSinceNudge = minutesSince(week.last_nudge, now);
  const localHour = localParts(now, cfg.timezone).hour;

  const outcome = decide(week, {
    minutes,
    hoursLeft,
    minutesSinceNudge,
    localHour,
    soften: holiday.soften,
    config: cfg,
  });

  switch (outcome.action) {
    case 'skip':
      // Holiday week ran out of time. Closed without penalty and without a
      // notification -- nobody needs telling that Christmas happened.
      //
      // Deliberately also converts an already-missed week. Holiday data can
      // arrive after the deadline (a first deploy, a failed fetch), and a week
      // penalised before the app knew it was a holiday should be corrected,
      // not left punished for the app's own ignorance.
      db.prepare(
        `UPDATE weeks SET status = 'skipped', missed_announced_at = ?, on_time = NULL,
         streak_lost = NULL WHERE week_key = ? AND status != 'skipped'`
      ).run(now.toISOString(), weekKey);
      db.prepare('DELETE FROM stakes WHERE week_key = ?').run(weekKey);
      logEvent(weekKey, 'skipped', holiday.name || 'holiday');
      break;
    case 'missed':
      // State only. The announcement waits for the quiet window to lift.
      markMissed(weekKey, now);
      break;
    case 'announce_missed': {
      const streakLost = Number(week.streak_lost ?? 0);
      await fire(weekKey, outcome.stage, now, cfg);
      await notifyPartnerOfMiss(weekKey, streakLost, cfg);
      db.prepare('UPDATE weeks SET missed_announced_at = ? WHERE week_key = ?').run(
        now.toISOString(),
        weekKey
      );
      break;
    }
    case 'stage':
      await fire(weekKey, outcome.stage, now, cfg, { isFixedRung: true });
      break;
    case 'siege':
    case 'overdue':
      await fire(weekKey, outcome.stage, now, cfg);
      break;
    default:
      break;
  }

  return { weekKey, action: outcome.action, stage: outcome.stage?.id ?? null };
}

let timer = null;

export function startScheduler() {
  if (timer) return;
  const run = () => {
    tick().catch((err) => console.error('[scheduler] tick failed:', err));
  };
  run();
  // A one-minute cadence is plenty: the tightest interval in the ladder is
  // measured in minutes, and every decision is derived from the clock rather
  // than from timers, so a missed tick self-heals on the next one.
  timer = setInterval(run, 60_000);
  console.log('[scheduler] running (60s cadence)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
