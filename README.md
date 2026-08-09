# Never Forget

An escalating weekly timesheet reminder. It starts polite on Friday morning and
becomes progressively harder to ignore until the timesheet is confirmed
submitted. One button ends it. Nothing else does.

Built for a specific problem: a weekly timesheet due before Saturday, reliably
remembered on Sunday, occasionally on Tuesday, with real consequences at review
time.

## How it works

| Friday (local) | What happens |
|---|---|
| 10:00 | Gentle reminder |
| 14:00 | Firmer |
| 16:00 | "Eight hours left" |
| 17:00 | "This is the part where it gets annoying" |
| 22:00 | Two-hour warning |
| 23:30 | Thirty-minute warning |
| 23:30 → midnight | **Siege** — repeats every 15 min, persistent notifications |
| Midnight | Week marked missed. Streak resets, stake is recorded |
| Sat/Sun 08:00–22:00 | Repeats every 45 min until submitted |

Two things stop the escalation, and only two: tapping **I submitted my
timesheet** in the app, or tapping **I submitted it** directly on the
notification.

Design decisions worth knowing:

- **Overnight nudges are suppressed** (22:00–08:00 by default). Nagging at 3am
  produces an uninstalled app, not a submitted timesheet. The Friday ladder
  itself ignores quiet hours, because the deadline *is* midnight.
- **The miss is recorded the instant it happens**, at midnight, but announced at
  08:00. The streak shouldn't depend on anyone being awake to hear about it.
- **An overdue week keeps ownership through the weekend** (4 days by default),
  so Saturday doesn't silently roll to a fresh week and forgive the miss.
- **Notifications carry the timesheet link.** The gap between "I should do this"
  and doing it is where this fails, so one tap closes it.

## Honest limitations

**The app cannot verify submission.** Deloitte's timesheet system is behind
corporate SSO/VPN with no API to check, so "submitted" means *she tapped the
button*. This is an honor system with teeth, not enforcement. Everything else
follows from that:

- It only works if she wants it to work. It is installed on her phone, under
  her control, with her access code. Built any other way it gets uninstalled in
  week two and you have a worse problem than a late timesheet.
- Stakes are a **ledger, not a payment processor**. It records what's owed and
  who settles it. Real money movement would need Stripe and is deliberately out
  of scope.

## Setup

```bash
npm install
npm run keys          # prints VAPID keys, session secret, and two access codes
cp .env.example .env  # paste the generated values in
npm start
```

Open `http://localhost:3000`, log in with `OWNER_CODE`, then:

1. **Enable on this device** — grants notification permission and registers for push.
2. **Send a test notification** — confirm delivery actually works before Friday.
3. Set the **timezone** and paste the **timesheet URL**.

The partner view is at `/partner`, using `PARTNER_CODE`.

### iPhone

Web push on iOS only works for home-screen apps. Open the site in Safari, tap
**Share → Add to Home Screen**, then open it from the icon and enable
notifications there. The app detects this case and says so. Notifications will
not arrive if it's left as a Safari tab.

### Deploying

Needs a always-on Node process — the scheduler ticks every 60 seconds — so a
small VPS, Fly.io, Render, or Railway all work; static/serverless hosts do not.
Requirements:

- **HTTPS**, mandatory for service workers and push.
- A persistent volume mounted at `DATA_DIR` (default `./data`), or the SQLite
  history is lost on redeploy.
- Set `NODE_ENV=production` so session cookies are marked secure.

## Testing the ladder

Rather than waiting a week to find out whether it works:

```bash
npm run simulate            # nobody confirms — watch the full escalation
npm run simulate -- 16:30   # confirmed at 16:30 Friday — watch it stop
```

This runs a real week through the real scheduler against a throwaway database
in `data/sim`, printing every notification it would send.

## Layout

```
server/
  index.js        Express app, API, auth-gated routes
  scheduler.js    60s tick; decides and sends
  escalation.js   The ladder — stages, siege, quiet hours (pure logic)
  week.js         Timezone/DST math, week ownership, deadlines
  db.js           SQLite schema, settings, streaks
  push.js         Web push delivery, dead-subscription cleanup
  simulate.js     Accelerated week simulator
public/           PWA: owner app, partner view, service worker
```

`escalation.js` is pure and takes the clock as input, which is what makes the
simulator possible — the ladder can be replayed at any speed without mocking
timers.

## Settings

Editable in-app: timezone, timesheet URL, stake amount and recipient, siege and
weekend intervals, quiet hours, grace period, display names.
