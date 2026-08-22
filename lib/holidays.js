// Public holiday detection, backed by Nager.Date (no key, no rate limit
// published, 100+ countries).
//
// Holidays matter here for two reasons, and the second is the important one:
//
//   1. Nagging someone 25 times on Christmas Day is how an app gets deleted.
//   2. When Friday is a company holiday the timesheet deadline usually moves
//      *earlier*, not later. Left unaware, the app would sit silent on the
//      real deadline and then escalate on a day nobody is working -- causing
//      exactly the miss it exists to prevent.
//
// Because holidays are known months ahead, the year is fetched once and
// cached; the network is never in the path of a decision. If the fetch fails
// the app carries on with whatever it last knew, and if it knows nothing it
// behaves exactly as it did before this feature existed.

export const HOLIDAY_API = 'https://date.nager.at/api/v3/PublicHolidays';

// Refresh weekly. The data barely changes, and a stale cache is far less
// harmful than a failed lookup blocking a nudge.
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function cacheIsFresh(cache, now = Date.now()) {
  if (!cache?.fetchedAt || !cache?.days) return false;
  return now - cache.fetchedAt < CACHE_TTL_MS;
}

export function cacheCovers(cache, year, country) {
  return Boolean(cache) && cache.country === country && (cache.years || []).includes(year);
}

// Nager returns [{ date, localName, name, global, counties, types }, ...].
// Only nationwide public holidays are kept: a county-scoped observance is not
// something a Deloitte office closes for, and treating one as a day off would
// wrongly suppress a real deadline.
export function normalize(entries) {
  const days = {};
  for (const e of entries || []) {
    if (!e?.date) continue;
    const isNationwide = e.global !== false;
    const isPublic = !Array.isArray(e.types) || e.types.includes('Public');
    if (!isNationwide || !isPublic) continue;
    days[e.date] = e.localName || e.name || 'Public holiday';
  }
  return days;
}

// Fetch one year. `fetchImpl` is injected so this is testable without network
// and so the caller controls timeouts.
export async function fetchYear(year, country, fetchImpl = fetch, timeoutMs = 8000) {
  const url = `${HOLIDAY_API}/${year}/${encodeURIComponent(country)}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`holiday api ${res.status}`);
    return normalize(await res.json());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fetch the current year and the next one, so a Friday in late December is
// still covered without waiting for a January refresh.
export async function buildCache(year, country, fetchImpl = fetch, now = Date.now()) {
  const years = [year, year + 1];
  const days = {};
  for (const y of years) {
    Object.assign(days, await fetchYear(y, country, fetchImpl));
  }
  return { country, years, days, fetchedAt: now };
}

// Name of the holiday on that date, or null. Pure.
export function holidayOn(cache, isoDate) {
  if (!cache?.days) return null;
  return cache.days[isoDate] || null;
}

// Decide what a holiday means for one week. Pure -- the cache is passed in.
//
// Returns { name, shiftDays, soften }:
//   name      the holiday landing on the week's Friday, or null
//   shiftDays how far to pull the due day earlier (0 or negative)
//   soften    run the reduced ladder and close the week without penalty
export function resolveHoliday({ weekKey, cache, handling = 'soften' }) {
  const none = { name: null, shiftDays: 0, soften: false };
  if (handling === 'off' || !cache?.days) return none;

  const name = holidayOn(cache, weekKey);
  if (!name) return none;
  if (handling !== 'shift') return { name, shiftDays: 0, soften: true };

  // Walk backwards to the first working day that is neither a holiday nor a
  // weekend. Thanksgiving is the case that matters: in 2026 both Thursday the
  // 26th and Friday the 27th are holidays, so a naive one-day shift would land
  // the whole ladder on another day off.
  const [y, m, d] = weekKey.split('-').map(Number);
  for (let back = 1; back <= 4; back += 1) {
    const probe = new Date(Date.UTC(y, m - 1, d - back));
    const iso = probe.toISOString().slice(0, 10);
    const dow = probe.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) continue;
    if (holidayOn(cache, iso)) continue;
    return { name, shiftDays: -back, soften: false };
  }

  // Nothing workable in range -- fall back to softening rather than inventing
  // a deadline on a day she was never going to be at a desk.
  return { name, shiftDays: 0, soften: true };
}

// Refresh the cache if it is stale or does not cover the year we need.
//
// Failure is never fatal and never blocks a decision: a network problem leaves
// the previous cache in place, and no cache at all means the app behaves
// exactly as it did before holiday detection existed.
export async function ensureCache({ get, set, country, now = Date.now(), fetchImpl = fetch }) {
  const existing = await get();
  const year = new Date(now).getUTCFullYear();
  if (cacheIsFresh(existing, now) && cacheCovers(existing, year, country)) return existing;

  try {
    const fresh = await buildCache(year, country, fetchImpl, now);
    await set(fresh);
    return fresh;
  } catch (err) {
    console.warn(`[holidays] refresh failed (${err.message}); using cached data`);
    return existing ?? null;
  }
}
