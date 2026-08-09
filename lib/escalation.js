// The ladder.
//
// One-shot stages fire once each, in order, at fixed points on Friday.
// After the last one the week enters "siege": a repeating notification on a
// short interval that does not stop until the week is confirmed. Once the
// deadline passes the week is marked missed -- streak resets, stakes land,
// partner is told -- and the repeating nudge continues through the weekend,
// because she still has to actually do the thing.
//
// Every stage is escapable in exactly one way: confirm the timesheet.

export const STAGES = [
  {
    id: 'morning',
    at: 10 * 60,
    urgency: 'normal',
    title: 'Timesheet day',
    body: 'It is Friday. Two minutes now beats the whole weekend of remembering.',
    requireInteraction: false,
  },
  {
    id: 'midday',
    at: 14 * 60,
    urgency: 'normal',
    title: 'Timesheet still open',
    body: 'Still not submitted. This is the easy window — do it before the afternoon eats you.',
    requireInteraction: false,
  },
  {
    id: 'afternoon',
    at: 16 * 60,
    urgency: 'high',
    title: 'Eight hours left',
    body: 'The timesheet is due before Saturday. You have the rest of today and that is it.',
    requireInteraction: true,
  },
  {
    id: 'evening',
    at: 18 * 60,
    urgency: 'high',
    title: 'Work is over. This is not.',
    body: 'Two minutes now and the whole weekend is clean. Nothing else has to happen tonight.',
    requireInteraction: true,
  },
  {
    id: 'hardstop',
    at: 20 * 60,
    urgency: 'high',
    title: 'Eight o’clock. Politeness is over.',
    body: 'You are home, you have your phone, and this takes two minutes. I will not stop now until it is done.',
    requireInteraction: true,
  },
  {
    id: 'night',
    at: 22 * 60,
    urgency: 'high',
    title: 'Two hours to deadline',
    body: 'Last comfortable moment. After midnight this becomes a missed week on the record.',
    requireInteraction: true,
  },
  {
    id: 'lastcall',
    at: 23 * 60 + 15,
    urgency: 'high',
    title: 'Forty-five minutes',
    body: 'Submit it now. Forty-five minutes and the streak is gone.',
    requireInteraction: true,
  },
];

export const SIEGE_STAGE = {
  id: 'siege',
  urgency: 'high',
  title: 'Timesheet — still not submitted',
  body: 'This will keep going until you confirm. That is the whole design.',
  requireInteraction: true,
};

export const OVERDUE_STAGE = {
  id: 'overdue',
  urgency: 'high',
  title: 'Overdue timesheet',
  body: 'The deadline passed. It is still not done, and it still has to be done.',
  requireInteraction: true,
};

export const MISSED_STAGE = {
  id: 'missed',
  urgency: 'high',
  title: 'Missed. Streak reset to zero.',
  body: 'Friday closed with the timesheet unsubmitted. Submit it now to stop the reminders.',
  requireInteraction: true,
};

// Siege starts at 20:00 rather than after the final rung. The evening is when
// she is home, has her phone, and can actually do it -- a ladder that stays
// quiet until 23:00 spends the one workable window saying nothing.
export const SIEGE_BEGINS_AT = 20 * 60;

// The siege tightens as the deadline approaches: the same nudge every fifteen
// minutes reads as background noise by hour three, and the cost of ignoring it
// is not constant -- it rises as the remaining time runs out. Expressed as
// factors of the configured base interval so one setting still controls it.
export const SIEGE_TIGHTENING = [
  { from: 20 * 60, factor: 1 },      // 8pm  -> every 15 min (default base)
  { from: 22 * 60, factor: 2 / 3 },  // 10pm -> every 10 min
  { from: 23 * 60, factor: 1 / 3 },  // 11pm -> every 5 min
];

export function siegeIntervalFor(minutes, baseInterval) {
  let factor = 1;
  for (const step of SIEGE_TIGHTENING) {
    if (minutes >= step.from) factor = step.factor;
  }
  return Math.max(1, Math.round(baseInterval * factor));
}

// Quiet hours wrap around midnight, e.g. start 22 / end 8.
export function isQuiet(localHour, { quietStart, quietEnd }) {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return localHour >= quietStart && localHour < quietEnd;
  return localHour >= quietStart || localHour < quietEnd;
}

// What should happen for this week right now?
//
// Returns one of:
//   {action:'none'}
//   {action:'stage',   stage}   -- fire a one-shot rung of the Friday ladder
//   {action:'siege',   stage}   -- repeating pre-deadline nudge
//   {action:'missed'}           -- cross the deadline; state only, no notification
//   {action:'announce_missed', stage} -- tell both of them it was missed
//   {action:'overdue', stage}   -- repeating post-deadline nudge
//
// `week` is the DB row. `minutes` is minutes into that week's Friday (local).
// `hoursLeft` is hours until the deadline; negative once overdue.
export function decide(week, { minutes, hoursLeft, minutesSinceNudge, localHour, config }) {
  if (week.status === 'confirmed') return { action: 'none' };

  const pastDeadline = hoursLeft <= 0;

  if (!pastDeadline) {
    // Before Friday has even started there is nothing to say.
    if (minutes < 0) return { action: 'none' };

    // Track ladder progress off `fixed_stage`, never off `stage` -- a siege
    // nudge overwrites `stage`, and reading that would make the ladder lose
    // its place and replay a rung it had already fired.
    const fired = week.fixed_stage;
    const firedIndex = fired ? STAGES.findIndex((s) => s.id === fired) : -1;

    // Fire the latest due rung we have not fired yet. If several came due
    // while the process was down, skip to the most recent rather than
    // dumping the whole backlog on her at once.
    let due = -1;
    for (let i = 0; i < STAGES.length; i += 1) {
      if (minutes >= STAGES[i].at) due = i;
    }
    if (due > firedIndex) return { action: 'stage', stage: STAGES[due] };

    // From 20:00 the siege runs between the remaining fixed rungs, tightening
    // as midnight approaches. Deliberately ignores quiet hours: the deadline
    // is midnight and she is awake.
    if (minutes >= SIEGE_BEGINS_AT) {
      const interval = siegeIntervalFor(minutes, config.siegeInterval);
      if (minutesSinceNudge >= interval) return { action: 'siege', stage: SIEGE_STAGE };
    }
    return { action: 'none' };
  }

  // Past the deadline. Record the miss the instant it happens -- the streak
  // and the stake should not depend on anyone being awake to hear about it --
  // but hold the announcement until a civilised hour.
  if (week.status !== 'missed') return { action: 'missed' };

  const quiet = isQuiet(localHour, config);
  if (!week.missed_announced_at) {
    return quiet ? { action: 'none' } : { action: 'announce_missed', stage: MISSED_STAGE };
  }
  if (quiet) return { action: 'none' };
  if (minutesSinceNudge >= config.weekendInterval) {
    return { action: 'overdue', stage: OVERDUE_STAGE };
  }
  return { action: 'none' };
}

// Human-readable pressure level, for the UI.
export function pressureLevel(week, { minutes, hoursLeft }) {
  if (week.status === 'confirmed') return { level: 0, label: 'Clear' };
  if (hoursLeft <= 0) return { level: 5, label: 'Overdue' };
  if (minutes >= SIEGE_BEGINS_AT) return { level: 4, label: 'Siege' };
  if (minutes >= 16 * 60) return { level: 3, label: 'Urgent' };
  if (minutes >= 12 * 60) return { level: 2, label: 'Due today' };
  if (minutes >= 0) return { level: 1, label: 'Due today' };
  return { level: 0, label: 'Upcoming' };
}
