import db, { setting, settingInt, settingBool, ensureWeek, getWeek, logEvent, currentStreak } from './db.js';
import { sendTo } from './push.js';
import { weekKeyFor, hoursUntilDeadline, minutesIntoFriday, formatWeekLabel, localParts } from './week.js';
import { decide } from './escalation.js';

function config() {
  return {
    timezone: setting('timezone'),
    graceDays: settingInt('grace_days'),
    siegeInterval: settingInt('siege_interval_minutes'),
    weekendInterval: settingInt('weekend_interval_minutes'),
    quietStart: settingInt('quiet_start_hour'),
    quietEnd: settingInt('quiet_end_hour'),
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

// One pass of the loop. Exported so tests and the simulator can drive it.
export async function tick(now = new Date()) {
  const cfg = config();
  const weekKey = weekKeyFor(now, cfg.timezone, cfg.graceDays);
  ensureWeek(weekKey);
  const week = getWeek(weekKey);

  const hoursLeft = hoursUntilDeadline(weekKey, cfg.timezone, now);
  const minutes = minutesIntoFriday(weekKey, cfg.timezone, now);
  const minutesSinceNudge = minutesSince(week.last_nudge, now);
  const localHour = localParts(now, cfg.timezone).hour;

  const outcome = decide(week, { minutes, hoursLeft, minutesSinceNudge, localHour, config: cfg });

  switch (outcome.action) {
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
