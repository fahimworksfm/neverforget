// Blobs-backed replacement for the self-hosted SQLite layer.
//
// Strong consistency is not optional here. The scheduled tick and the confirm
// request run in different function instances; with eventual consistency a
// confirm could take up to a minute to become visible, and she would be
// nagged again seconds after submitting. That single failure would discredit
// the whole app, so every read is strongly consistent.

import { getStore, getDeployStore } from '@netlify/blobs';
import { DEFAULT_SETTINGS as SHARED_DEFAULTS } from '../../lib/settings.js';

export type Role = 'owner' | 'partner';

export interface Week {
  week_key: string;
  status: 'pending' | 'confirmed' | 'missed' | 'skipped';
  confirmed_at: string | null;
  missed_at: string | null;
  on_time: number | null;
  last_nudge: string | null;
  nudge_count: number;
  stage: string | null;
  fixed_stage: string | null;
  missed_announced_at: string | null;
  streak_lost: number | null;
  holiday_name: string | null;
  due_shift: number;
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

// Shared with the self-hosted target; see lib/settings.js.
export const DEFAULT_SETTINGS: Record<string, string> = SHARED_DEFAULTS;

// Read from BOTH sources rather than choosing one.
//
// The earlier version returned as soon as the `Netlify` global existed, so if
// `Netlify.env.get()` came back empty it never consulted `process.env` -- and
// every secret silently read as missing. Which of the two is populated depends
// on runtime and plan (scoped env vars are not a free-tier feature), so the
// only safe thing is to try both and take whichever answers.
function fromNetlifyEnv(name: string): string | undefined {
  try {
    // @ts-expect-error -- the Netlify global is absent under plain node.
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      // @ts-expect-error -- see above.
      return Netlify.env.get(name) || undefined;
    }
  } catch {
    // A runtime without the global should degrade, not throw.
  }
  return undefined;
}

export function env(name: string): string | undefined {
  return fromNetlifyEnv(name) ?? process.env[name] ?? undefined;
}

// Where a given name resolves from. Booleans only -- never values.
export function envSource(name: string) {
  return {
    netlify: Boolean(fromNetlifyEnv(name)),
    process: Boolean(process.env[name]),
  };
}

export function hasNetlifyGlobal(): boolean {
  // @ts-expect-error -- probing for the global is the entire point.
  return typeof Netlify !== 'undefined';
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
    holiday_name: null,
    due_shift: 0,
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
  guard?: (w: Week) => boolean,
  { createIfMissing = true }: { createIfMissing?: boolean } = {}
): Promise<Week | null> {
  const existing = await getWeek(weekKey);
  // Without this the blankWeek fallback lets a caller resurrect a week that
  // /api/reset deleted mid-tick -- and a blank week is `pending`, so a status
  // guard would happily wave it through and re-close (and re-charge) it.
  if (!existing && !createIfMissing) return null;
  const current = existing ?? blankWeek(weekKey);
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
    // A holiday week is neutral: it neither extends the streak nor breaks it,
    // because she was never asked to do anything.
    if (w.status === 'skipped') continue;
    if (w.status === 'confirmed' && w.on_time === 1) streak += 1;
    else break;
  }
  return streak;
}

export function bestStreak(weeks: Week[]): number {
  let best = 0;
  let run = 0;
  for (const w of weeks.filter((w) => w.status !== 'pending')) {
    if (w.status === 'skipped') continue;
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

// Used when a week turns out to have been a holiday after it was already
// closed as missed -- the charge should not survive the correction.
export async function dropStake(weekKey: string): Promise<void> {
  await store().delete(`stakes/${weekKey}`);
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
  // Drop this endpoint from the OTHER role first. A device that has been
  // logged in as both would otherwise stay registered as the owner forever
  // and keep receiving the full siege ladder. The SQLite target gets this
  // free from the UNIQUE constraint on endpoint; here it has to be explicit.
  const other: Role = role === 'owner' ? 'partner' : 'owner';
  const otherSubs = await getSubs(other);
  if (otherSubs.some((s) => s.endpoint === sub.endpoint)) {
    await putSubs(other, otherSubs.filter((s) => s.endpoint !== sub.endpoint));
  }

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

// Wipes week history and the stakes ledger, keeping settings and registered
// devices. Used to hand over a clean slate after a testing session -- nobody
// should inherit a streak built out of dry runs.
export async function clearHistory(): Promise<number> {
  const s = store();
  const [weeks, stakes] = await Promise.all([
    s.list({ prefix: 'weeks/' }),
    s.list({ prefix: 'stakes/' }),
  ]);
  const keys = [...weeks.blobs, ...stakes.blobs].map((b) => b.key);
  await Promise.all(keys.map((k) => s.delete(k)));
  await s.delete('flags/manual_nudge').catch(() => {});
  return keys.length;
}

// Fetched data, not a preference -- kept out of the settings blob so a bad
// settings write can never corrupt it and vice versa.
export async function getHolidayCache(): Promise<any | null> {
  return (await store().get('holiday-cache', { type: 'json' })) as any | null;
}

export async function setHolidayCache(cache: unknown): Promise<void> {
  await store().setJSON('holiday-cache', cache);
}

export async function getRecord<T>(key: string): Promise<T | null> {
  return (await store().get(`flags/${key}`, { type: 'json' })) as T | null;
}

export async function putRecord(key: string, value: unknown): Promise<void> {
  await store().setJSON(`flags/${key}`, value);
}

export async function getFlag(key: string): Promise<number> {
  const v = (await store().get(`flags/${key}`, { type: 'json' })) as { at: number } | null;
  return v?.at ?? 0;
}

export async function setFlag(key: string, at: number): Promise<void> {
  await store().setJSON(`flags/${key}`, { at });
}
