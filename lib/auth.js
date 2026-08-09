// Session tokens and access-code checking, with no host framework and no
// ambient environment reads -- every secret is passed in. Shared by the
// self-hosted Express server and the Netlify functions so there is exactly
// one copy of the security-relevant logic.

import crypto from 'node:crypto';

export const COOKIE = 'nf_session';
export const MAX_AGE_DAYS = 365;

const ROLES = ['owner', 'partner'];

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function issueToken(role, secret, now = Date.now()) {
  const payload = `${role}.${now}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;

  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload, secret);
  // Compare BYTE lengths, not string lengths. A multi-byte character makes
  // the two differ, and timingSafeEqual throws RangeError on unequal buffers
  // -- which would surface as a 500 instead of a clean rejection.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  const [role, issued] = payload.split('.');
  if (!ROLES.includes(role)) return null;
  if (now - Number(issued) > MAX_AGE_DAYS * 86_400_000) return null;
  return role;
}

// Compare two secrets without leaking length or content through timing.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function roleForCode(code, { ownerCode, partnerCode }) {
  if (typeof code !== 'string' || !code) return null;
  if (ownerCode && safeEqual(code, ownerCode)) return 'owner';
  if (partnerCode && safeEqual(code, partnerCode)) return 'partner';
  return null;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // A stray '%' in any unrelated cookie on the domain would otherwise
      // throw here and take down every API route with a 500.
      out[key] = raw;
    }
  }
  return out;
}

export function cookieString(value, { secure = true, maxAge = MAX_AGE_DAYS * 86_400 } = {}) {
  const bits = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
