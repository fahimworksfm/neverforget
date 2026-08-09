// Blobs-backed replacement for the self-hosted SQLite layer.
//
// Strong consistency is not optional here. The scheduled tick and the confirm
// request run in different function instances; with eventual consistency a
// confirm could take up to a minute to become visible, and she would be
// nagged again seconds after submitting. That single failure would discredit
// the whole app, so every read is strongly consistent.

import { getStore, getDeployStore } from '@netlify/blobs';

export type Role = 'owner' | 'partner';

export interface Week {
  week_key: string;
  status: 'pending' | 'confirmed' | 'missed';
  confirmed_at: string | null;
  missed_at: string | null;
  on_time: number | null;
  last_nudge: string | null;
  nudge_count: number;
  stage: string | null;
  fixed_stage: string | null;
  missed_announced_at: string | null;
  streak_lost: number | null;
  created_at: string;
}

export interface Stake {
  week_key: string;
  amount: number;
  status: 'owed' | 'settled' | 'waived';
  settled_at: string | null;
  created_at: string;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  created_at: string;
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  timezone: 'America/New_York',
  timesheet_url: '',
  owner_name: 'Maria',
  partner_name: 'Partner',
  stakes_enabled: '0',
  stakes_amount: '20',
  stakes_recipient: 'a cause you actively dislike',
  grace_days: '4',
  siege_interval_minutes: '15',
  weekend_interval_minutes: '45',
  quiet_end_hour: '8',
  quiet_start_hour: '22',
};

export function env(name: string): string | undefined {
  // @ts-expect-error -- the Netlify global is absent when running under plain node.
  if (typeof Netlify !== 'undefined') return Netlify.env.get(name) ?? undefined;
  return process.env[name];
}

function store() {
  const opts = { name: 'neverforget', consistency: 'strong' as const };
  // Keep preview/branch deploys off the production data set.
  // @ts-expect-error -- Netlify global typing varies by runtime.
  const ctx = typeof Netlify !== 'undefined' ? Netlify.context?.deploy?.context : undefined;
  return ctx && ctx !== 'production' ? getDeployStore(opts) : getStore(opts);
}

// ------------------------------------------------------------------ settings

export async function getSettings(): Promise<Record<string, string>> {
  const saved = (await store().get('settings', { type: 'json' })) as Record<string, string> | null;
  const envTz = env('TZ_HOUSEHOLD');
  return { ...DEFAULT_SETTINGS, ...(envTz ? { timezone: envTz } : {}), ...(saved || {}) };
}

export async function saveSettings(patch: Record<string, string>): Promise<Record<string, string>> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await store().setJSON('settings', next);
  return next;
}

export function config(settings: Record<string, string>) {
  return {
    timezone: settings.timezone,
    graceDays: Number(settings.grace_days),
    siegeInterval: Number(settings.siege_interval_minutes),
    weekendInterval: Number(settings.weekend_interval_minutes),
    quietStart: Number(settings.quiet_start_hour),
    quietEnd: Number(settings.quiet_end_hour),
  };
}

// --------------------------------------------------------------------- weeks

function blankWeek(weekKey: string): Week {
  return {
    week_key: weekKey,
    status: 'pending',
    confirmed_at: null,
    missed_at: null,
    on_time: null,
    last_nudge: null,
    nudge_count: 0,
    stage: null,
    fixed_stage: null,
    missed_announced_at: null,
    streak_lost: null,
    created_at: new Date().toISOString(),
  };
}

export async function getWeek(weekKey: string): Promise<Week | null> {
  return (await store().get(`weeks/${weekKey}`, { type: 'json' })) as Week | null;
}

export async function ensureWeek(weekKey: string): Promise<Week> {
  const existing = await getWeek(weekKey);
  if (existing) return existing;
  const fresh = blankWeek(weekKey);
  await store().setJSON(`weeks/${weekKey}`, fresh);
  return fresh;
}

// Re-read immediately before writing so a confirm landing mid-tick is not
// clobbered by stale in-memory state. Not a true transaction -- Blobs has no
// compare-and-swap -- but it narrows the race to microseconds, and `guard`
// lets a caller bail once it sees the world has moved.
export async function updateWeek(
  weekKey: string,
  mutate: (w: Week) => Week,
  guard?: (w: Week) => boolean
): Promise<Week | null> {
  const current = (await getWeek(weekKey)) ?? blankWeek(weekKey);
  if (guard && !guard(current)) return null;
  const next = mutate({ ...current });
  await store().setJSON(`weeks/${weekKey}`, next);
  return next;
}

export async function allWeeks(): Promise<Week[]> {
  const { blobs } = await store().list({ prefix: 'weeks/' });
  const weeks = await Promise.all(
    blobs.map((b) => store().get(b.key, { type: 'json' }) as Promise<Week | null>)
  );
  return weeks
    .filter((w): w is Week => Boolean(w))
    .sort((a, b) => a.week_key.localeCompare(b.week_key));
}

export function currentStreak(weeks: Week[]): number {
  const resolved = weeks.filter((w) => w.status !== 'pending').reverse();
  let streak = 0;
  for (const w of resolved) {
    if (w.status === 'confirmed' && w.on_time === 1) streak += 1;
    else break;
  }
  return streak;
}

export function bestStreak(weeks: Week[]): number {
  let best = 0;
  let run = 0;
  for (const w of weeks.filter((w) => w.status !== 'pending')) {
    if (w.status === 'confirmed' && w.on_time === 1) {
      run += 1;
      best = Math.max(best, run);
    } else run = 0;
  }
  return best;
}

// -------------------------------------------------------------------- stakes

export async function getStakes(): Promise<Stake[]> {
  const { blobs } = await store().list({ prefix: 'stakes/' });
  const stakes = await Promise.all(
    blobs.map((b) => store().get(b.key, { type: 'json' }) as Promise<Stake | null>)
  );
  return stakes
    .filter((s): s is Stake => Boolean(s))
    .sort((a, b) => b.week_key.localeCompare(a.week_key));
}

export async function recordStake(weekKey: string, amount: number): Promise<void> {
  const existing = (await store().get(`stakes/${weekKey}`, { type: 'json' })) as Stake | null;
  if (existing) return; // A week can only cost you once.
  await store().setJSON(`stakes/${weekKey}`, {
    week_key: weekKey,
    amount,
    status: 'owed',
    settled_at: null,
    created_at: new Date().toISOString(),
  } satisfies Stake);
}

export async function settleStake(weekKey: string, waive: boolean): Promise<void> {
  const existing = (await store().get(`stakes/${weekKey}`, { type: 'json' })) as Stake | null;
  if (!existing) return;
  await store().setJSON(`stakes/${weekKey}`, {
    ...existing,
    status: waive ? 'waived' : 'settled',
    settled_at: new Date().toISOString(),
  });
}

// ------------------------------------------------------------- subscriptions

export async function getSubs(role: Role): Promise<PushSub[]> {
  return ((await store().get(`subs/${role}`, { type: 'json' })) as PushSub[] | null) || [];
}

export async function putSubs(role: Role, subs: PushSub[]): Promise<void> {
  await store().setJSON(`subs/${role}`, subs);
}

export async function addSub(role: Role, sub: PushSub): Promise<number> {
  const subs = await getSubs(role);
  const next = subs.filter((s) => s.endpoint !== sub.endpoint);
  next.push(sub);
  await putSubs(role, next);
  return next.length;
}

export async function dropSub(role: Role, endpoint: string): Promise<void> {
  const subs = await getSubs(role);
  await putSubs(
    role,
    subs.filter((s) => s.endpoint !== endpoint)
  );
}

// --------------------------------------------------------------------- misc

export async function getFlag(key: string): Promise<number> {
  const v = (await store().get(`flags/${key}`, { type: 'json' })) as { at: number } | null;
  return v?.at ?? 0;
}

export async function setFlag(key: string, at: number): Promise<void> {
  await store().setJSON(`flags/${key}`, { at });
}
