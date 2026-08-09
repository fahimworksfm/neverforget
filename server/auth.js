import crypto from 'node:crypto';

const SECRET =
  process.env.SESSION_SECRET ||
  // Ephemeral fallback: sessions do not survive a restart, which is safe but
  // annoying. Set SESSION_SECRET in .env for anything long-lived.
  crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set -- logins will drop on restart.');
}

const MAX_AGE_DAYS = 365;

export const COOKIE = 'nf_session';

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

export function issue(role) {
  const payload = `${role}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function verify(token) {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload);
  // Constant-time compare; bail if lengths differ so timingSafeEqual cannot throw.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const [role, issued] = payload.split('.');
  if (!['owner', 'partner'].includes(role)) return null;
  if (Date.now() - Number(issued) > MAX_AGE_DAYS * 86_400_000) return null;
  return role;
}

// Compare two secrets without leaking length or content through timing.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function roleForCode(code) {
  const ownerCode = process.env.OWNER_CODE;
  const partnerCode = process.env.PARTNER_CODE;
  if (ownerCode && safeEqual(code, ownerCode)) return 'owner';
  if (partnerCode && safeEqual(code, partnerCode)) return 'partner';
  return null;
}

export const codesConfigured = Boolean(process.env.OWNER_CODE);

export function requireRole(...roles) {
  return (req, res, next) => {
    const role = verify(req.cookies?.[COOKIE]);
    if (!role) return res.status(401).json({ error: 'not_authenticated' });
    if (roles.length && !roles.includes(role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.role = role;
    next();
  };
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_DAYS * 86_400_000,
    path: '/',
  };
}
