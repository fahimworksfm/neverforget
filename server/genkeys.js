import webpush from 'web-push';
import crypto from 'node:crypto';

const keys = webpush.generateVAPIDKeys();

console.log(`
Add these to your .env file:

VAPID_PUBLIC_KEY=${keys.publicKey}
VAPID_PRIVATE_KEY=${keys.privateKey}
VAPID_CONTACT=mailto:you@example.com
SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}
OWNER_CODE=${crypto.randomBytes(4).toString('hex')}
PARTNER_CODE=${crypto.randomBytes(4).toString('hex')}

The two codes are the logins. OWNER_CODE is Maria's, PARTNER_CODE is yours.
Rotate them by changing these values and restarting.
`);
