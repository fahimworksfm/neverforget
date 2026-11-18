// The partner's manual nudge, shared by both deployment targets.
//
// One an hour keeps it a nudge and not a weapon. The partner may write the
// text; it is trimmed, stripped of control characters and capped, because it
// lands on her lock screen verbatim.

export const NUDGE_COOLDOWN_MS = 60 * 60 * 1000;
export const NUDGE_MAX_LENGTH = 140;
export const DEFAULT_NUDGE_BODY = 'The timesheet is still showing as unsubmitted.';

export function cleanNudgeMessage(raw) {
  if (typeof raw !== 'string') return DEFAULT_NUDGE_BODY;
  const text = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NUDGE_MAX_LENGTH);
  return text || DEFAULT_NUDGE_BODY;
}

// When the next manual nudge is allowed, as an ISO string, or null if now.
export function nudgeAvailableAt(lastAt, now = Date.now()) {
  if (!lastAt) return null;
  const at = lastAt + NUDGE_COOLDOWN_MS;
  return at > now ? new Date(at).toISOString() : null;
}

// Week keys are the Friday's ISO date. Anything else in a URL is refused.
export const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
