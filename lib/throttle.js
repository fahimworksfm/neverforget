// Per-client failed-attempt throttling.
//
// The first version of this was a single global counter, which turned a
// brute-force defence into a denial of service: eight anonymous wrong guesses
// locked Maria out of her own app for fifteen minutes, repeatable forever. A
// lockout must never be triggerable by someone who is not the account holder,
// so attempts are tracked per client instead.
//
// Deliberately in-memory. On the serverless target that means the counter
// resets on cold start and is not shared across instances -- weaker against a
// distributed attacker, but it costs nothing, and the alternative (persisting
// every failure) lets anonymous traffic drive unbounded metered writes, which
// is its own denial of service.

export function createThrottle({
  maxFails = 8,
  lockoutMs = 15 * 60_000,
  ttlMs = 60 * 60_000,
  maxKeys = 5000,
} = {}) {
  const hits = new Map();

  function expire(now) {
    for (const [key, entry] of hits) {
      if (now - entry.seen > ttlMs) hits.delete(key);
    }
  }

  // Hard ceiling so a spray of unique clients cannot grow the map without end.
  // Runs after the insert, not before, or the map settles at maxKeys + 1.
  function enforceCeiling() {
    if (hits.size <= maxKeys) return;
    const excess = hits.size - maxKeys;
    let i = 0;
    for (const key of hits.keys()) {
      if (i++ >= excess) break;
      hits.delete(key);
    }
  }

  return {
    // { locked: boolean, retryInSeconds: number }
    check(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || entry.until <= now) return { locked: false, retryInSeconds: 0 };
      return { locked: true, retryInSeconds: Math.ceil((entry.until - now) / 1000) };
    },

    fail(key, now = Date.now()) {
      expire(now);
      const entry = hits.get(key) ?? { fails: 0, until: 0, seen: now };
      entry.fails += 1;
      entry.seen = now;
      if (entry.fails >= maxFails) {
        entry.fails = 0;
        entry.until = now + lockoutMs;
      }
      hits.set(key, entry);
      enforceCeiling();
      return entry;
    },

    reset(key) {
      hits.delete(key);
    },

    get size() {
      return hits.size;
    },
  };
}

// Best-effort client identity. Never trusted for authorisation -- only to keep
// one misbehaving client from locking out everyone else.
export function clientKey(headers, fallback = 'unknown') {
  const get = (name) =>
    typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  const ip =
    get('x-nf-client-connection-ip') ||
    (get('x-forwarded-for') || '').split(',')[0].trim() ||
    get('client-ip') ||
    fallback;
  return ip || fallback;
}
