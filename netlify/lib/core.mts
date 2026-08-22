// Everything that both the API and the scheduled tick need to agree on.
//
// The ladder itself (../../lib/escalation.js) and the calendar maths
// (../../lib/week.js) are shared verbatim with the self-hosted server. They are
// pure and take the clock as an argument, so they port across runtimes with no
// changes and stay testable by the simulator.

import {
  weekKeyFor,
  hoursUntilDeadline,
  minutesIntoDueDay,
  deadlineFor,
  dueDateFor,
  formatWeekLabel,
  localParts,
  formatClock,
} from '../../lib/week.js';
import {
  decide,
  pressureLevel,
  PREVIEWABLE,
  SIEGE_BEGINS_AT,
} from '../../lib/escalation.js';
import {
  getSettings,
  config,
  ensureWeek,
  getWeek,
  updateWeek,
  allWeeks,
  currentStreak,
  bestStreak,
  getStakes,
  recordStake,
  dropStake,
  getFlag,
  setFlag,
  getHolidayCache,
  setHolidayCache,
  getSubs,
  type Week,
} from './store.mjs';
import { sendTo, pushConfigured } from './push.mjs';
import { ensureCache, resolveHoliday } from '../../lib/holidays.js';

export async function buildState(role: string) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const now = new Date();
  const weekKey = weekKeyFor(now, tz, Number(settings.grace_days));

  const week = await ensureWeek(weekKey);
  const weeks = await allWeeks();
  const stakes = await getStakes();

  const cache = await getHolidayCache();
  const holiday = resolveHoliday({ weekKey, cache, handling: settings.holiday_handling });

  const hoursLeft = hoursUntilDeadline(weekKey, tz, now, holiday.shiftDays);
  const minutes = minutesIntoDueDay(weekKey, tz, now, holiday.shiftDays);

  return {
    role,
    now: now.toISOString(),
    timezone: tz,
    week: {
      key: weekKey,
      label: formatWeekLabel(weekKey, tz),
      status: week.status,
      confirmedAt: week.confirmed_at,
      onTime: week.on_time === 1,
      nudgeCount: week.nudge_count,
      stage: week.stage,
      deadline: deadlineFor(weekKey, tz, holiday.shiftDays).toISOString(),
      hoursLeft,
      minutesIntoDueDay: minutes,
      dueDate: dueDateFor(weekKey, holiday.shiftDays).iso,
      siegeBeginsAt: SIEGE_BEGINS_AT,
    },
    holiday: {
      name: holiday.name,
      shiftDays: holiday.shiftDays,
      soften: holiday.soften,
      handling: settings.holiday_handling,
      country: settings.holiday_country,
      known: Boolean(cache),
    },
    pressure: pressureLevel(week, { minutes, hoursLeft, soften: holiday.soften }),
    streak: currentStreak(weeks),
    best: bestStreak(weeks),
    history: weeks.slice(-12).map((w) => ({
      key: w.week_key,
      label: formatWeekLabel(w.week_key, tz),
      status: w.status,
      onTime: w.on_time === 1,
      nudgeCount: w.nudge_count,
      holiday: (w as any).holiday_name || null,
    })),
    stakes: {
      enabled: settings.stakes_enabled === '1',
      amount: Number(settings.stakes_amount),
      recipient: settings.stakes_recipient,
      outstanding: stakes.filter((s) => s.status === 'owed').reduce((n, s) => n + s.amount, 0),
      ledger: stakes.map((s) => ({ week: s.week_key, amount: s.amount, status: s.status })),
    },
    names: { owner: settings.owner_name, partner: settings.partner_name },
    timesheetUrl: settings.timesheet_url,
    devices: {
      owner: (await getSubs('owner')).length,
      partner: (await getSubs('partner')).length,
    },
    pushConfigured: pushConfigured(),
    // Clock strings are formatted here, once, so the UI never restates the
    // ladder's times and cannot drift when a rung moves.
    ladder: PREVIEWABLE.map((s: any) => ({
      id: s.id,
      at: s.at ?? null,
      clock: s.clockLabel ?? formatClock(s.at),
      label: s.label,
      title: s.title,
    })),
  };
}

export async function confirmWeek() {
  const settings = await getSettings();
  const tz = settings.timezone;
  const now = new Date();
  const weekKey = weekKeyFor(now, tz, Number(settings.grace_days));
  const week = await ensureWeek(weekKey);

  if (week.status === 'confirmed') return { alreadyConfirmed: true, onTime: week.on_time === 1 };

  const holiday = resolveHoliday({
    weekKey,
    cache: await getHolidayCache(),
    handling: settings.holiday_handling,
  });
  const onTime = hoursUntilDeadline(weekKey, tz, now, holiday.shiftDays) > 0;
  await updateWeek(weekKey, (w) => ({
    ...w,
    status: 'confirmed',
    confirmed_at: now.toISOString(),
    on_time: onTime ? 1 : 0,
  }));

  const label = formatWeekLabel(weekKey, tz);
  const streak = currentStreak(await allWeeks());
  await sendTo('partner', {
    tag: `confirm-${weekKey}`,
    title: onTime ? `${settings.owner_name} submitted on time` : `${settings.owner_name} submitted (late)`,
    body: onTime
      ? `${label} timesheet done. Streak: ${streak}.`
      : `${label} timesheet done, after the deadline.`,
    urgency: 'normal',
    url: '/partner',
  });

  return { alreadyConfirmed: false, onTime };
}

export async function unconfirmWeek() {
  const settings = await getSettings();
  const tz = settings.timezone;
  const now = new Date();
  const weekKey = weekKeyFor(now, tz, Number(settings.grace_days));
  const holiday = resolveHoliday({
    weekKey,
    cache: await getHolidayCache(),
    handling: settings.holiday_handling,
  });
  // Undo fixes a mis-tap; it does not buy time. Reopening a week whose
  // deadline has already passed drops it straight back to missed -- or to
  // skipped, on a softened holiday week.
  const overdue = hoursUntilDeadline(weekKey, tz, now, holiday.shiftDays) <= 0;
  const status: Week['status'] = !overdue ? 'pending' : holiday.soften ? 'skipped' : 'missed';
  await updateWeek(weekKey, (w) => ({ ...w, status, confirmed_at: null, on_time: null }));
}

function minutesSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}

async function fire(weekKey: string, stage: any, url: string, now: Date, isFixedRung: boolean) {
  const delivered = await sendTo('owner', {
    tag: `timesheet-${weekKey}`,
    renotify: true,
    title: stage.title,
    body: stage.body,
    urgency: stage.urgency,
    requireInteraction: stage.requireInteraction,
    stage: stage.id,
    weekKey,
    url,
  });

  // Guard on status: if she confirmed while the push was in flight, do not
  // write nudge bookkeeping back over the confirmation.
  await updateWeek(
    weekKey,
    (w) => ({
      ...w,
      last_nudge: now.toISOString(),
      nudge_count: w.nudge_count + 1,
      stage: stage.id,
      fixed_stage: isFixedRung ? stage.id : w.fixed_stage,
    }),
    (w) => w.status !== 'confirmed'
  );

  return delivered;
}

// Close out any week that fell off the end of its grace window while still
// pending. Without this the tick only ever looks at the current week, so an
// abandoned one stays `pending` forever -- and because both streak functions
// skip pending weeks, the miss is silently forgiven.
//
// Swept weeks are recorded but never announced: a push about a three-week-old
// Friday is noise. Rate-limited to once an hour because allWeeks() is one
// strongly-consistent blob read per week ever recorded, and the condition it
// looks for changes at most once a week -- running it every two minutes would
// undo the whole reason the tick cadence is two minutes.
async function sweepAbandoned(currentKey: string, settings: Record<string, string>, now: Date) {
  const last = await getFlag('last_sweep');
  if (now.getTime() - last < 3_600_000) return 0;
  await setFlag('last_sweep', now.getTime());

  const stale = (await allWeeks()).filter(
    (w) =>
      w.status === 'pending' &&
      w.week_key !== currentKey &&
      hoursUntilDeadline(w.week_key, settings.timezone, now) <= 0
  );

  for (const w of stale) {
    // Deliberately no stake. A swept week is one the app never actually
    // nudged her about -- downtime, a fresh deploy, leftover dry runs -- and
    // billing for silence would make money appear out of nowhere.
    await updateWeek(
      w.week_key,
      (x) => ({
        ...x,
        status: 'missed',
        missed_at: now.toISOString(),
        on_time: 0,
        streak_lost: 0,
        missed_announced_at: now.toISOString(),
      }),
      (x) => x.status === 'pending',
      { createIfMissing: false }
    );
  }
  return stale.length;
}

// One pass of the scheduler. Returns what it did, for logging.
export async function runTick(now = new Date()) {
  const settings = await getSettings();
  const cfg = config(settings);
  const weekKey = weekKeyFor(now, cfg.timezone, cfg.graceDays);
  let week = await ensureWeek(weekKey);
  await sweepAbandoned(weekKey, settings, now);

  const cache = await ensureCache({
    get: getHolidayCache,
    set: setHolidayCache,
    country: settings.holiday_country,
    now: now.getTime(),
  });
  const holiday = resolveHoliday({ weekKey, cache, handling: settings.holiday_handling });

  // Record what the holiday meant for this week, so history stays truthful
  // even if the setting changes later.
  if (week.holiday_name !== holiday.name || week.due_shift !== holiday.shiftDays) {
    week =
      (await updateWeek(weekKey, (w) => ({
        ...w,
        holiday_name: holiday.name,
        due_shift: holiday.shiftDays,
      }))) ?? week;
  }

  const hoursLeft = hoursUntilDeadline(weekKey, cfg.timezone, now, holiday.shiftDays);
  const minutes = minutesIntoDueDay(weekKey, cfg.timezone, now, holiday.shiftDays);
  const localHour = localParts(now, cfg.timezone).hour;
  const minutesSinceNudge = minutesSince(week.last_nudge, now);

  const outcome = decide(week, {
    minutes,
    hoursLeft,
    minutesSinceNudge,
    localHour,
    soften: holiday.soften,
    config: cfg,
  });
  const url = settings.timesheet_url || '/';

  switch (outcome.action) {
    case 'skip': {
      // Holiday week ran out of time. Closed without penalty and without a
      // notification -- nobody needs telling that Christmas happened.
      //
      // Deliberately also converts an already-missed week. Holiday data can
      // arrive after the deadline (a first deploy, a failed fetch), and a week
      // penalised before the app knew it was a holiday should be corrected,
      // not left punished for the app's own ignorance.
      const corrected = await updateWeek(
        weekKey,
        (w) => ({
          ...w,
          status: 'skipped',
          on_time: null,
          streak_lost: null,
          missed_announced_at: now.toISOString(),
        }),
        (w) => w.status !== 'skipped',
        { createIfMissing: false }
      );
      if (corrected) await dropStake(weekKey);
      break;
    }
    case 'missed': {
      // Record the miss the moment it happens; announce it at a civil hour.
      const streakLost = currentStreak(await allWeeks());
      const applied = await updateWeek(
        weekKey,
        (w) => ({
          ...w,
          status: 'missed',
          missed_at: now.toISOString(),
          on_time: 0,
          streak_lost: streakLost,
        }),
        (w) => w.status !== 'confirmed'
      );
      // Only bill for the miss if the miss actually stuck. The guard returns
      // null when she confirmed inside the race window, and charging her for
      // a week she submitted is the worst mistake this app could make.
      if (applied && settings.stakes_enabled === '1') {
        await recordStake(weekKey, Number(settings.stakes_amount));
      }
      break;
    }

    case 'announce_missed': {
      const fresh = await getWeek(weekKey);
      if (fresh?.status === 'confirmed') break;
      await fire(weekKey, outcome.stage, url, now, false);
      await sendTo('partner', {
        tag: `miss-${weekKey}`,
        title: `${settings.owner_name} missed the ${formatWeekLabel(weekKey, cfg.timezone)} timesheet`,
        body: (fresh?.streak_lost ?? 0) > 0
          ? `Friday closed unsubmitted. A ${fresh!.streak_lost}-week streak just ended.`
          : 'Friday closed unsubmitted. Worth a nudge in person.',
        urgency: 'high',
        url: '/partner',
      });
      await updateWeek(weekKey, (w) => ({ ...w, missed_announced_at: now.toISOString() }));
      break;
    }

    case 'stage':
      await fire(weekKey, outcome.stage, url, now, true);
      break;

    case 'siege':
    case 'overdue':
      await fire(weekKey, outcome.stage, url, now, false);
      break;

    default:
      break;
  }

  return { weekKey, action: outcome.action, stage: outcome.stage?.id ?? null };
}
