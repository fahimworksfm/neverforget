import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db, {
  setting,
  settingBool,
  setSetting,
  allSettings,
  ensureWeek,
  getWeek,
  recentWeeks,
  currentStreak,
  bestStreak,
  logEvent,
  stakesLedger,
  outstandingStakes,
  clearHistory,
} from './db.js';
import { publicKey, saveSubscription, removeSubscription, subscriptionCount, sendTo, pushConfigured } from './push.js';
import {
  weekKeyFor,
  hoursUntilDeadline,
  minutesIntoFriday,
  deadlineFor,
  formatWeekLabel,
  formatClock,
} from '../lib/week.js';
import {
  pressureLevel,
  STAGES,
  SIEGE_BEGINS_AT,
  SIEGE_STAGE,
  OVERDUE_STAGE,
  MISSED_STAGE,
  PREVIEWABLE,
} from '../lib/escalation.js';
import { startScheduler, tick } from './scheduler.js';
import { COOKIE, issue, verify, roleForCode, requireRole, cookieOptions, codesConfigured } from './auth.js';
import { validateSettingsPatch } from '../lib/settings.js';
import { createThrottle } from '../lib/throttle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

// Behind a reverse proxy (Fly, Render, nginx) the real client address arrives
// in X-Forwarded-For, and Express only believes that header when told which
// hops to trust. Left unset, every request looks like it came from the proxy,
// which would collapse the per-client login throttle back into a single global
// counter -- exactly the lockout-anyone bug it exists to avoid. Trusting it
// unconditionally is the opposite mistake: then a client can spoof the header
// and sidestep the throttle entirely. So it is opt-in and explicit.
const TRUST_PROXY = (() => {
  const raw = process.env.TRUST_PROXY;
  if (!raw) return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // preset name or comma-separated address list
})();
app.set('trust proxy', TRUST_PROXY);

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// ---------------------------------------------------------------- state

function buildState() {
  const timezone = setting('timezone');
  const graceDays = Number(setting('grace_days'));
  const now = new Date();
  const weekKey = weekKeyFor(now, timezone, graceDays);
  ensureWeek(weekKey);
  const week = getWeek(weekKey);

  const hoursLeft = hoursUntilDeadline(weekKey, timezone, now);
  const minutes = minutesIntoFriday(weekKey, timezone, now);
  const pressure = pressureLevel(week, { minutes, hoursLeft });

  return {
    now: now.toISOString(),
    timezone,
    week: {
      key: weekKey,
      label: formatWeekLabel(weekKey, timezone),
      status: week.status,
      confirmedAt: week.confirmed_at,
      onTime: week.on_time === 1,
      nudgeCount: week.nudge_count,
      stage: week.stage,
      deadline: deadlineFor(weekKey, timezone).toISOString(),
      hoursLeft,
      minutesIntoFriday: minutes,
      siegeBeginsAt: SIEGE_BEGINS_AT,
    },
    pressure,
    streak: currentStreak(),
    best: bestStreak(),
    history: recentWeeks(12).map((w) => ({
      key: w.week_key,
      label: formatWeekLabel(w.week_key, timezone),
      status: w.status,
      onTime: w.on_time === 1,
      nudgeCount: w.nudge_count,
    })),
    stakes: {
      enabled: settingBool('stakes_enabled'),
      amount: Number(setting('stakes_amount')),
      recipient: setting('stakes_recipient'),
      outstanding: outstandingStakes(),
      ledger: stakesLedger().map((s) => ({
        week: s.week_key,
        amount: s.amount,
        status: s.status,
      })),
    },
    names: { owner: setting('owner_name'), partner: setting('partner_name') },
    timesheetUrl: setting('timesheet_url'),
    devices: { owner: subscriptionCount('owner'), partner: subscriptionCount('partner') },
    pushConfigured,
    // Clock strings are formatted here, once, so the UI never restates the
    // ladder's times and cannot drift when a rung moves.
    ladder: PREVIEWABLE.map((s) => ({
      id: s.id,
      at: s.at ?? null,
      clock: s.clockLabel ?? formatClock(s.at),
      label: s.label,
      title: s.title,
    })),
  };
}

// ---------------------------------------------------------------- auth

app.get('/api/session', (req, res) => {
  const role = verify(req.cookies?.[COOKIE]);
  res.json({ role, codesConfigured });
});

// The access codes are short and human-typeable, which is right for a phone
// but leaves them guessable given unlimited attempts. Keyed per client so a
// stranger's wrong guesses can never lock out the account holder.
const loginThrottle = createThrottle();

app.post('/api/login', (req, res) => {
  const { code } = req.body || {};
  if (!codesConfigured) {
    return res.status(500).json({ error: 'codes_not_configured' });
  }
  if (typeof code !== 'string' || !code) {
    return res.status(400).json({ error: 'code_required' });
  }
  const who = req.ip || 'unknown';
  const gate = loginThrottle.check(who);
  if (gate.locked) {
    return res.status(429).json({ error: 'locked_out', retryInSeconds: gate.retryInSeconds });
  }
  const role = roleForCode(code);
  if (!role) {
    loginThrottle.fail(who);
    logEvent(null, 'login_failed');
    return res.status(401).json({ error: 'bad_code' });
  }
  loginThrottle.reset(who);
  res.cookie(COOKIE, issue(role), cookieOptions());
  logEvent(null, 'login', role);
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- core api

app.get('/api/state', requireRole('owner', 'partner'), (req, res) => {
  res.json({ role: req.role, ...buildState() });
});

app.get('/api/vapid', requireRole('owner', 'partner'), (req, res) => {
  res.json({ key: publicKey() });
});

app.post('/api/subscribe', requireRole('owner', 'partner'), (req, res) => {
  const { subscription, label } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'bad_subscription' });
  }
  saveSubscription(req.role, subscription, label);
  logEvent(null, 'subscribed', req.role);
  res.json({ ok: true, devices: subscriptionCount(req.role) });
});

app.post('/api/unsubscribe', requireRole('owner', 'partner'), (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) removeSubscription(endpoint);
  res.json({ ok: true });
});

// The one escape hatch. Everything the app does exists to drive this call.
app.post('/api/confirm', requireRole('owner'), async (req, res) => {
  const timezone = setting('timezone');
  const graceDays = Number(setting('grace_days'));
  const now = new Date();
  const weekKey = weekKeyFor(now, timezone, graceDays);
  ensureWeek(weekKey);
  const week = getWeek(weekKey);

  if (week.status === 'confirmed') {
    return res.json({ ok: true, alreadyConfirmed: true, ...buildState() });
  }

  const hoursLeft = hoursUntilDeadline(weekKey, timezone, now);
  const onTime = hoursLeft > 0;

  db.prepare(
    "UPDATE weeks SET status = 'confirmed', confirmed_at = ?, on_time = ? WHERE week_key = ?"
  ).run(now.toISOString(), onTime ? 1 : 0, weekKey);
  logEvent(weekKey, 'confirmed', onTime ? 'on_time' : 'late');

  const owner = setting('owner_name');
  const label = formatWeekLabel(weekKey, timezone);
  const streak = currentStreak();
  await sendTo(
    'partner',
    {
      tag: `confirm-${weekKey}`,
      title: onTime ? `${owner} submitted on time` : `${owner} submitted (late)`,
      body: onTime
        ? `${label} timesheet done. Streak: ${streak}.`
        : `${label} timesheet done, after the deadline.`,
      urgency: 'normal',
      url: '/partner',
    },
    weekKey
  );

  res.json({ ok: true, onTime, ...buildState() });
});

// Undo, for the inevitable mis-tap.
app.post('/api/unconfirm', requireRole('owner'), (req, res) => {
  const timezone = setting('timezone');
  const now = new Date();
  const weekKey = weekKeyFor(now, timezone, Number(setting('grace_days')));
  const hoursLeft = hoursUntilDeadline(weekKey, timezone, now);
  // Reopening a week that is already past its deadline puts it straight back
  // into the missed state -- undo corrects a mis-tap, it does not buy time.
  const status = hoursLeft > 0 ? 'pending' : 'missed';
  db.prepare(
    'UPDATE weeks SET status = ?, confirmed_at = NULL, on_time = NULL WHERE week_key = ?'
  ).run(status, weekKey);
  logEvent(weekKey, 'unconfirmed');
  res.json({ ok: true, ...buildState() });
});

app.get('/api/settings', requireRole('owner'), (req, res) => {
  res.json(allSettings());
});

app.post('/api/settings', requireRole('owner'), (req, res) => {
  const { patch, error } = validateSettingsPatch(req.body || {});
  if (error) return res.status(400).json({ error });
  for (const [k, v] of Object.entries(patch)) setSetting(k, v);
  logEvent(null, 'settings_updated', Object.keys(patch).join(','));
  res.json({ ok: true, settings: allSettings() });
});

app.post('/api/stakes/:week/settle', requireRole('owner', 'partner'), (req, res) => {
  const status = req.body?.waive ? 'waived' : 'settled';
  db.prepare('UPDATE stakes SET status = ?, settled_at = ? WHERE week_key = ?').run(
    status,
    new Date().toISOString(),
    req.params.week
  );
  logEvent(req.params.week, `stakes_${status}`);
  res.json({ ok: true, ...buildState() });
});

// A manual nudge from the partner. Rate-limited to one an hour so it stays a
// nudge and not a weapon.
let lastManualNudge = 0;
app.post('/api/nudge', requireRole('partner'), async (req, res) => {
  const now = Date.now();
  if (now - lastManualNudge < 3_600_000) {
    const mins = Math.ceil((3_600_000 - (now - lastManualNudge)) / 60_000);
    return res.status(429).json({ error: 'rate_limited', retryInMinutes: mins });
  }
  const timezone = setting('timezone');
  const weekKey = weekKeyFor(new Date(), timezone, Number(setting('grace_days')));
  const week = getWeek(weekKey);
  if (week?.status === 'confirmed') {
    return res.status(409).json({ error: 'already_confirmed' });
  }
  lastManualNudge = now;
  const delivered = await sendTo(
    'owner',
    {
      tag: `timesheet-${weekKey}`,
      renotify: true,
      title: `A nudge from ${setting('partner_name')}`,
      body: 'The timesheet is still showing as unsubmitted.',
      urgency: 'high',
      requireInteraction: true,
      stage: 'manual',
      weekKey,
      url: setting('timesheet_url') || '/',
    },
    weekKey
  );
  logEvent(weekKey, 'manual_nudge', `-> ${delivered} device(s)`);
  res.json({ ok: true, delivered });
});

app.post('/api/test-push', requireRole('owner', 'partner'), async (req, res) => {
  const delivered = await sendTo(req.role, {
    tag: 'test',
    title: 'Test notification',
    body: 'If you can see this, delivery works. This is what Friday will feel like.',
    urgency: 'normal',
    requireInteraction: false,
    url: '/',
  });
  res.json({ ok: true, delivered, configured: pushConfigured });
});

// Manual tick, for debugging the ladder without waiting for a clock edge.
app.post('/api/tick', requireRole('owner'), async (req, res) => {
  const result = await tick();
  res.json(result);
});

// Fire any rung on demand without touching week state. The only honest way to
// judge whether Friday is too gentle or too brutal is to feel the real thing.
app.post('/api/preview', requireRole('owner'), async (req, res) => {
  const id = String(req.body?.stage || 'evening');
  const stage = PREVIEWABLE.find((s) => s.id === id);
  if (!stage) return res.status(400).json({ error: 'unknown_stage', id });

  const delivered = await sendTo('owner', {
    tag: 'preview',
    renotify: true,
    title: `[preview] ${stage.title}`,
    body: stage.body,
    urgency: stage.urgency,
    requireInteraction: stage.requireInteraction,
    stage: stage.id,
    url: setting('timesheet_url') || '/',
  });
  res.json({ ok: true, delivered, stage: id });
});

app.post('/api/reset', requireRole('owner'), (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'confirm_required' });
  const removed = clearHistory();
  logEvent(null, 'history_cleared', String(removed));
  res.json({ ok: true, removed, ...buildState() });
});

app.get('/api/events', requireRole('owner', 'partner'), (req, res) => {
  const rows = db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100')
    .all();
  res.json(rows);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- static

app.get('/partner', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partner.html')));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[neverforget] listening on :${PORT}`);
    console.log(`[neverforget] timezone: ${setting('timezone')}`);
    startScheduler();
  });
}

export default app;
