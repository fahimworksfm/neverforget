// Express binding for the shared auth logic in lib/auth.js.

import crypto from 'node:crypto';
import {
  COOKIE,
  MAX_AGE_DAYS,
  issueToken,
  verifyToken,
  roleForCode as roleForCodeCore,
} from '../lib/auth.js';

const SECRET =
  process.env.SESSION_SECRET ||
  // Ephemeral fallback: sessions do not survive a restart, which is safe but
  // annoying. Set SESSION_SECRET in .env for anything long-lived.
  crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set -- logins will drop on restart.');
}

export { COOKIE };

export const codesConfigured = Boolean(process.env.OWNER_CODE);

export const issue = (role) => issueToken(role, SECRET);
export const verify = (token) => verifyToken(token, SECRET);
export const roleForCode = (code) =>
  roleForCodeCore(code, {
    ownerCode: process.env.OWNER_CODE,
    partnerCode: process.env.PARTNER_CODE,
  });

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
