import type { Config } from '@netlify/functions';
import {
  COOKIE,
  issueToken,
  verifyToken,
  roleForCode,
  parseCookies,
  cookieString,
} from '../../lib/auth.js';
import {
  env,
  getSettings,
  saveSettings,
  addSub,
  dropSub,
  getSubs,
  getStakes,
  settleStake,
  getWeek,
  getFlag,
  setFlag,
  DEFAULT_SETTINGS,
} from '../lib/store.mjs';
import { publicKey, pushConfigured, sendTo } from '../lib/push.mjs';
import { buildState, confirmWeek, unconfirmWeek, runTick } from '../lib/core.mjs';
import { weekKeyFor } from '../../lib/week.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

function sessionRole(req: Request): string | null {
  const secret = env('SESSION_SECRET');
  if (!secret) return null;
  return verifyToken(parseCookies(req.headers.get('cookie'))[COOKIE], secret);
}

const EDITABLE = new Set(Object.keys(DEFAULT_SETTINGS));
const NUMERIC = new Set([
  'grace_days',
  'siege_interval_minutes',
  'weekend_interval_minutes',
  'quiet_start_hour',
  'quiet_end_hour',
]);

export default async (req: Request) => {
  const { pathname } = new URL(req.url);
  const route = pathname.replace(/^\/api\/?/, '');
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  // ------------------------------------------------------------ public
  if (route === 'session') {
    return json({ role: sessionRole(req), codesConfigured: Boolean(env('OWNER_CODE')) });
  }

  if (route === 'login' && req.method === 'POST') {
    const secret = env('SESSION_SECRET');
    if (!secret || !env('OWNER_CODE')) return json({ error: 'codes_not_configured' }, 500);

    const role = roleForCode((body as any).code, {
      ownerCode: env('OWNER_CODE'),
      partnerCode: env('PARTNER_CODE'),
    });
    if (!role) return json({ error: 'bad_code' }, 401);

    return json({ role }, 200, { 'Set-Cookie': cookieString(issueToken(role, secret)) });
  }

  if (route === 'logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookieString('', { maxAge: 0 }) });
  }

  // ----------------------------------------------------------- gated
  const role = sessionRole(req);
  if (!role) return json({ error: 'not_authenticated' }, 401);
  const ownerOnly = () => role === 'owner';

  switch (route) {
    case 'state':
      return json(await buildState(role));

    case 'vapid':
      return json({ key: publicKey() });

    case 'subscribe': {
      const { subscription, label } = body as any;
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return json({ error: 'bad_subscription' }, 400);
      }
      const devices = await addSub(role as any, {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        label,
        created_at: new Date().toISOString(),
      });
      return json({ ok: true, devices });
    }

    case 'unsubscribe': {
      const { endpoint } = body as any;
      if (endpoint) await dropSub(role as any, endpoint);
      return json({ ok: true });
    }

    case 'confirm': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      const result = await confirmWeek();
      return json({ ok: true, ...result, ...(await buildState(role)) });
    }

    case 'unconfirm': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      await unconfirmWeek();
      return json({ ok: true, ...(await buildState(role)) });
    }

    case 'settings': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      if (req.method !== 'POST') return json(await getSettings());

      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (!EDITABLE.has(k)) continue;
        if (k === 'timezone') {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: String(v) });
          } catch {
            return json({ error: 'bad_timezone' }, 400);
          }
        }
        if (NUMERIC.has(k)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return json({ error: `bad_${k}` }, 400);
        }
        patch[k] = String(v);
      }
      return json({ ok: true, settings: await saveSettings(patch) });
    }

    case 'nudge': {
      // Partner-initiated. Rate-limited to one an hour so it stays a nudge.
      if (role !== 'partner') return json({ error: 'forbidden' }, 403);
      const last = await getFlag('manual_nudge');
      const since = Date.now() - last;
      if (since < 3_600_000) {
        return json({ error: 'rate_limited', retryInMinutes: Math.ceil((3_600_000 - since) / 60_000) }, 429);
      }
      const settings = await getSettings();
      const weekKey = weekKeyFor(new Date(), settings.timezone, Number(settings.grace_days));
      const week = await getWeek(weekKey);
      if (week?.status === 'confirmed') return json({ error: 'already_confirmed' }, 409);

      await setFlag('manual_nudge', Date.now());
      const delivered = await sendTo('owner', {
        tag: `timesheet-${weekKey}`,
        renotify: true,
        title: `A nudge from ${settings.partner_name}`,
        body: 'The timesheet is still showing as unsubmitted.',
        urgency: 'high',
        requireInteraction: true,
        stage: 'manual',
        weekKey,
        url: settings.timesheet_url || '/',
      });
      return json({ ok: true, delivered });
    }

    case 'test-push': {
      const delivered = await sendTo(role as any, {
        tag: 'test',
        title: 'Test notification',
        body: 'If you can see this, delivery works. This is what Friday will feel like.',
        urgency: 'normal',
        url: '/',
      });
      return json({ ok: true, delivered, configured: pushConfigured() });
    }

    case 'stakes': {
      return json(await getStakes());
    }

    case 'tick': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      return json(await runTick());
    }

    default: {
      // /api/stakes/<week>/settle
      const m = route.match(/^stakes\/([\d-]+)\/settle$/);
      if (m && req.method === 'POST') {
        await settleStake(m[1], Boolean((body as any).waive));
        return json({ ok: true, ...(await buildState(role)) });
      }
      return json({ error: 'not_found', route }, 404);
    }
  }
};

export const config: Config = {
  path: '/api/*',
};
