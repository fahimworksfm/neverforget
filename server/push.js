import webpush from 'web-push';
import db, { logEvent } from './db.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

export const pushConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn(
    '[push] VAPID keys missing -- notifications will be logged, not delivered.\n' +
      '       Run `npm run keys` and put them in .env'
  );
}

export function publicKey() {
  return PUBLIC_KEY || null;
}

export function saveSubscription(role, sub, label = null) {
  db.prepare(
    `INSERT INTO subscriptions (role, endpoint, p256dh, auth, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       role = excluded.role,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       failures = 0`
  ).run(role, sub.endpoint, sub.keys.p256dh, sub.keys.auth, label, new Date().toISOString());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
}

export function subscriptionCount(role) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE role = ?')
    .get(role).n;
}

function subsFor(role) {
  return db.prepare('SELECT * FROM subscriptions WHERE role = ?').all(role);
}

// Send to every device registered for a role. Returns how many landed.
export async function sendTo(role, payload, weekKey = null) {
  const subs = subsFor(role);
  if (!pushConfigured) {
    console.log(`[push:dry-run] -> ${role}: ${payload.title} -- ${payload.body}`);
    logEvent(weekKey, 'push_dry_run', `${role}: ${payload.title}`);
    return 0;
  }
  if (subs.length === 0) {
    logEvent(weekKey, 'push_no_devices', role);
    return 0;
  }

  const body = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(
    subs.map(async (row) => {
      const sub = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webpush.sendNotification(sub, body, {
          urgency: payload.urgency || 'high',
          TTL: payload.ttl ?? 1800,
        });
        delivered += 1;
        if (row.failures > 0) {
          db.prepare('UPDATE subscriptions SET failures = 0 WHERE id = ?').run(row.id);
        }
      } catch (err) {
        const gone = err.statusCode === 404 || err.statusCode === 410;
        if (gone) {
          // The browser threw this subscription away; stop trying it.
          removeSubscription(row.endpoint);
          logEvent(weekKey, 'push_expired', `${role} device dropped`);
        } else {
          db.prepare('UPDATE subscriptions SET failures = failures + 1 WHERE id = ?').run(row.id);
          logEvent(weekKey, 'push_error', `${role}: ${err.statusCode || err.message}`);
        }
      }
    })
  );

  return delivered;
}
