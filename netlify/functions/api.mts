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
  envSource,
  hasNetlifyGlobal,
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
  getRecord,
  putRecord,
  clearHistory,
} from '../lib/store.mjs';
import { publicKey, pushConfigured, sendTo } from '../lib/push.mjs';
import { buildState, confirmWeek, unconfirmWeek, runTick } from '../lib/core.mjs';
import { weekKeyFor } from '../../lib/week.js';
import { STAGES, SIEGE_STAGE, OVERDUE_STAGE, MISSED_STAGE } from '../../lib/escalation.js';
import { validateSettingsPatch } from '../../lib/settings.js';

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


export default async (req: Request) => {
  const { pathname } = new URL(req.url);
  const route = pathname.replace(/^\/api\/?/, '');
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  // ------------------------------------------------------------ public
  if (route === 'session') {
    // Booleans only, never values. Without this there is no way to tell a
    // mistyped code from a server that cannot see its own configuration --
    // both surface to the user as a failed login.
    return json({
      role: sessionRole(req),
      codesConfigured: Boolean(env('OWNER_CODE')),
      config: {
        ownerCode: Boolean(env('OWNER_CODE')),
        partnerCode: Boolean(env('PARTNER_CODE')),
        sessionSecret: Boolean(env('SESSION_SECRET')),
        vapidPublic: Boolean(env('VAPID_PUBLIC_KEY')),
        vapidPrivate: Boolean(env('VAPID_PRIVATE_KEY')),
      },
      // Distinguishes "the variable is not set on the site" from "it is set
      // but this runtime exposes it somewhere else". Names and booleans only.
      diag: {
        netlifyGlobal: hasNetlifyGlobal(),
        ownerCodeFrom: envSource('OWNER_CODE'),
        visibleEnvNames: Object.keys(process.env).filter((k) =>
          ['OWNER_CODE', 'PARTNER_CODE', 'SESSION_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'TZ_HOUSEHOLD', 'VAPID_CONTACT'].includes(k)
        ),
      },
    });
  }

  if (route === 'login' && req.method === 'POST') {
    const secret = env('SESSION_SECRET');
    if (!secret || !env('OWNER_CODE')) return json({ error: 'codes_not_configured' }, 500);

    // The access codes are short and human-typeable, which is the right call
    // for a phone but leaves them guessable if an attacker can try forever.
    // Lock out after a handful of misses; a real user never hits this.
    const throttle = (await getRecord<{ fails: number; until: number }>('login_throttle')) ?? {
      fails: 0,
      until: 0,
    };
    if (throttle.until > Date.now()) {
      return json(
        { error: 'locked_out', retryInSeconds: Math.ceil((throttle.until - Date.now()) / 1000) },
        429
      );
    }

    const role = roleForCode((body as any).code, {
      ownerCode: env('OWNER_CODE'),
      partnerCode: env('PARTNER_CODE'),
    });

    if (!role) {
      const fails = throttle.fails + 1;
      const locked = fails >= 8;
      await putRecord('login_throttle', {
        fails: locked ? 0 : fails,
        until: locked ? Date.now() + 15 * 60_000 : 0,
      });
      console.warn(`[auth] failed login (${fails}/8)${locked ? ' -- locked for 15 min' : ''}`);
      return json({ error: 'bad_code' }, 401);
    }

    if (throttle.fails) await putRecord('login_throttle', { fails: 0, until: 0 });
    return json({ role }, 200, { 'Set-Cookie': cookieString(issueToken(role, secret)) });
  }

  if (route === 'logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookieString('', { maxAge: 0 }) });
  }

  // ----------------------------------------------------------- gated
  const role = sessionRole(req);
  if (!role) return json({ error: 'not_authenticated' }, 401);
  const ownerOnly = () => role === 'owner';

  // Every state-changing route must be POST. The session cookie is
  // SameSite=Lax, which still rides along on top-level GET navigations, so
  // without this a bare link to /api/confirm would silently close her week.
  // The Express target gets this free from app.post(); this is the parity fix.
  const MUTATING =
    /^(confirm|unconfirm|subscribe|unsubscribe|nudge|test-push|tick|preview|reset|stakes\/[\d-]+\/settle)$/;
  if (MUTATING.test(route) && req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

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

      const { patch, error } = validateSettingsPatch(body as Record<string, unknown>);
      if (error) return json({ error }, 400);
      return json({ ok: true, settings: await saveSettings(patch!) });
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

    // Fire any rung of the ladder on demand, without touching week state.
    // The only honest way to judge whether Friday is too gentle or too brutal
    // is to feel the actual notification on an actual phone.
    case 'preview': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      const id = String((body as any).stage || 'evening');
      const stage =
        [...STAGES, SIEGE_STAGE, OVERDUE_STAGE, MISSED_STAGE].find((s: any) => s.id === id);
      if (!stage) return json({ error: 'unknown_stage', id }, 400);

      const settings = await getSettings();
      const delivered = await sendTo('owner', {
        tag: 'preview',
        renotify: true,
        title: `[preview] ${(stage as any).title}`,
        body: (stage as any).body,
        urgency: (stage as any).urgency,
        requireInteraction: (stage as any).requireInteraction,
        stage: (stage as any).id,
        url: settings.timesheet_url || '/',
      });
      return json({ ok: true, delivered, stage: id });
    }

    case 'reset': {
      if (!ownerOnly()) return json({ error: 'forbidden' }, 403);
      if ((body as any).confirm !== 'RESET') return json({ error: 'confirm_required' }, 400);
      const removed = await clearHistory();
      return json({ ok: true, removed, ...(await buildState(role)) });
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
