// The single definition of what a setting is, what it defaults to, and what
// counts as a legal value.
//
// This lives here because the two deployment targets have now drifted on this
// exact concept three separate times: different editable keys, different
// numeric floors, different upper bounds. Any rule expressed twice eventually
// disagrees with itself, so both targets import this one.

export const DEFAULT_SETTINGS = {
  timezone: 'America/New_York',
  timesheet_url: '',
  owner_name: 'Maria',
  partner_name: 'Partner',
  stakes_enabled: '0',
  stakes_amount: '20',
  stakes_recipient: 'a cause you actively dislike',
  // Days after Friday during which an overdue week stays current.
  grace_days: '4',
  siege_interval_minutes: '15',
  weekend_interval_minutes: '45',
  // Post-deadline nudges are held inside this window. Nagging at 3am does not
  // produce a submitted timesheet, it produces an uninstalled app.
  quiet_end_hour: '8',
  quiet_start_hour: '22',
};

// Intervals must be at least a minute -- zero would fire the siege on every
// tick. Quiet-hour boundaries are clock hours and legitimately include zero.
export const NUMERIC_BOUNDS = {
  grace_days: { min: 1, max: 6 },
  siege_interval_minutes: { min: 1, max: 240 },
  weekend_interval_minutes: { min: 1, max: 720 },
  quiet_start_hour: { min: 0, max: 23 },
  quiet_end_hour: { min: 0, max: 23 },
  stakes_amount: { min: 0, max: 100000 },
};

export const EDITABLE = new Set(Object.keys(DEFAULT_SETTINGS));

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value) });
    return true;
  } catch {
    return false;
  }
}

// Returns { patch } on success or { error } on the first invalid field.
// Unknown keys are dropped silently rather than rejected, so a client sending
// extra fields cannot lock the user out of saving.
export function validateSettingsPatch(updates = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE.has(key)) continue;

    if (key === 'timezone' && !isValidTimezone(value)) {
      return { error: 'bad_timezone' };
    }

    const bounds = NUMERIC_BOUNDS[key];
    if (bounds) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
        return { error: `bad_${key}` };
      }
    }

    patch[key] = String(value);
  }
  return { patch };
}
