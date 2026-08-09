import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'neverforget.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,             -- 'owner' (Maria) | 'partner'
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL,
    failures   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS weeks (
    week_key     TEXT PRIMARY KEY,        -- the Friday, YYYY-MM-DD, household tz
    status       TEXT NOT NULL,           -- 'pending' | 'confirmed' | 'missed'
    confirmed_at TEXT,
    missed_at    TEXT,
    on_time      INTEGER,                 -- 1 if confirmed before deadline
    last_nudge   TEXT,
    nudge_count  INTEGER NOT NULL DEFAULT 0,
    stage        TEXT,                    -- last escalation stage fired
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key   TEXT,
    type       TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stakes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key   TEXT NOT NULL UNIQUE,
    amount     REAL NOT NULL,
    status     TEXT NOT NULL,             -- 'owed' | 'settled' | 'waived'
    settled_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_week ON events(week_key);
  CREATE INDEX IF NOT EXISTS idx_subs_role   ON subscriptions(role);
`);

// Additive migrations. `stage` records whatever fired last (for display);
// `fixed_stage` records only the last one-shot rung, so a repeating siege
// nudge cannot make the ladder forget where it was and replay a rung.
function addColumn(table, name, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}
addColumn('weeks', 'fixed_stage', 'TEXT');
addColumn('weeks', 'missed_announced_at', 'TEXT');
// Captured at the moment of the miss, because by announcement time the streak
// has already been reset and the number would be gone.
addColumn('weeks', 'streak_lost', 'INTEGER');

const DEFAULTS = {
  timezone: process.env.TZ_HOUSEHOLD || 'America/New_York',
  timesheet_url: '',
  owner_name: 'Maria',
  partner_name: 'Fahim',
  stakes_enabled: '0',
  stakes_amount: '20',
  stakes_recipient: 'a cause you actively dislike',
  // Grace window (days after Friday) during which an overdue week stays current.
  grace_days: '4',
  siege_interval_minutes: '15',
  weekend_interval_minutes: '45',
  // Post-deadline nudges are held inside this window. Nagging at 3am does not
  // produce a submitted timesheet, it produces an uninstalled app. The Friday
  // ladder itself ignores quiet hours -- the deadline is midnight, so the late
  // rungs are the entire point.
  quiet_end_hour: '8',
  quiet_start_hour: '22',
};

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!getSetting.get(k)) putSetting.run(k, v);
}

export function setting(key) {
  const row = getSetting.get(key);
  return row ? row.value : DEFAULTS[key];
}

export function settingInt(key) {
  return Number(setting(key));
}

export function settingBool(key) {
  return setting(key) === '1' || setting(key) === 'true';
}

export function setSetting(key, value) {
  putSetting.run(key, String(value));
}

export function allSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return out;
}

export function logEvent(weekKey, type, detail = null) {
  db.prepare(
    'INSERT INTO events (week_key, type, detail, created_at) VALUES (?, ?, ?, ?)'
  ).run(weekKey, type, detail, new Date().toISOString());
}

export function ensureWeek(weekKey) {
  const existing = db.prepare('SELECT * FROM weeks WHERE week_key = ?').get(weekKey);
  if (existing) return existing;
  db.prepare(
    'INSERT INTO weeks (week_key, status, created_at) VALUES (?, ?, ?)'
  ).run(weekKey, 'pending', new Date().toISOString());
  logEvent(weekKey, 'week_opened');
  return db.prepare('SELECT * FROM weeks WHERE week_key = ?').get(weekKey);
}

export function getWeek(weekKey) {
  return db.prepare('SELECT * FROM weeks WHERE week_key = ?').get(weekKey);
}

// The most recent `limit` weeks, returned oldest-first so callers can render
// them straight onto a left-to-right timeline. The Netlify target returns the
// same order; a client reading both must not have to care which it is talking
// to.
export function recentWeeks(limit = 12) {
  return db
    .prepare('SELECT * FROM weeks ORDER BY week_key DESC LIMIT ?')
    .all(limit)
    .reverse();
}

// Consecutive on-time weeks, counting back from the most recent resolved week.
// A pending week is skipped rather than counted -- the streak is about
// finished weeks, and the current one has not finished yet.
export function currentStreak() {
  const weeks = db
    .prepare("SELECT * FROM weeks WHERE status != 'pending' ORDER BY week_key DESC")
    .all();
  let streak = 0;
  for (const w of weeks) {
    if (w.status === 'confirmed' && w.on_time === 1) streak += 1;
    else break;
  }
  return streak;
}

export function bestStreak() {
  const weeks = db
    .prepare("SELECT * FROM weeks WHERE status != 'pending' ORDER BY week_key ASC")
    .all();
  let best = 0;
  let run = 0;
  for (const w of weeks) {
    if (w.status === 'confirmed' && w.on_time === 1) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

// Wipes week history and the stakes ledger, keeping settings and devices.
// Used to hand over a clean slate after a testing session.
export function clearHistory() {
  const n =
    db.prepare('SELECT COUNT(*) AS n FROM weeks').get().n +
    db.prepare('SELECT COUNT(*) AS n FROM stakes').get().n;
  db.exec('DELETE FROM weeks; DELETE FROM stakes; DELETE FROM events;');
  return n;
}

export function stakesLedger() {
  return db.prepare('SELECT * FROM stakes ORDER BY week_key DESC').all();
}

export function outstandingStakes() {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM stakes WHERE status = 'owed'")
    .get();
  return row.total;
}

export default db;
