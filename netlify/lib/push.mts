import webpush from 'web-push';
import { env, getSubs, putSubs, type Role } from './store.mjs';

export interface Payload {
  title: string;
  body: string;
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  stage?: string;
  weekKey?: string;
  url?: string;
  ttl?: number;
}

export function pushConfigured(): boolean {
  return Boolean(env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY'));
}

export function publicKey(): string | null {
  return env('VAPID_PUBLIC_KEY') || null;
}

function configure(): boolean {
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(
    env('VAPID_CONTACT') || 'mailto:admin@example.com',
    env('VAPID_PUBLIC_KEY')!,
    env('VAPID_PRIVATE_KEY')!
  );
  return true;
}

export async function sendTo(role: Role, payload: Payload): Promise<number> {
  if (!configure()) {
    console.log(`[push:dry-run] -> ${role}: ${payload.title}`);
    return 0;
  }

  const subs = await getSubs(role);
  if (!subs.length) return 0;

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let delivered = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          body,
          { urgency: payload.urgency || 'high', TTL: payload.ttl ?? 1800 }
        );
        delivered += 1;
      } catch (err: any) {
        // 404/410 mean the browser discarded this subscription for good.
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(s.endpoint);
        else console.error(`[push] ${role} ${err?.statusCode || err?.message}`);
      }
    })
  );

  if (dead.length) {
    await putSubs(role, subs.filter((s) => !dead.includes(s.endpoint)));
  }
  return delivered;
}
