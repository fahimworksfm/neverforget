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
| 10 AM | Gentle reminder |
| 2 PM | Firmer |
| 4 PM | "Eight hours left" |
| 6 PM | "Work is over. This is not." |
| **8 PM** | **"Politeness is over."** Siege begins — repeats every 15 min |
| 10 PM | Two-hour warning; siege tightens to every 10 min |
| 11 PM | Siege tightens to every 5 min |
| 11:15 PM | Forty-five-minute warning |
| Midnight | Week marked missed. Streak resets, stake is recorded |
| Sat/Sun 8 AM – 10 PM | Repeats every 45 min until submitted |

The siege tightens as the deadline nears rather than running at a fixed
cadence: the same nudge every fifteen minutes reads as background noise by
hour three, and the cost of ignoring it is not constant. Doing nothing from
8 PM to midnight costs about 25 notifications; confirming costs one tap.

Two things stop the escalation, and only two: tapping **I submitted my
timesheet** in the app, or tapping **I submitted it** directly on the
notification.

Design decisions worth knowing:

- **Overnight nudges are suppressed** (10 PM – 8 AM by default). Nagging at 3am
  produces an uninstalled app, not a submitted timesheet. The Friday ladder
  itself ignores quiet hours, because the deadline *is* midnight.
- **The miss is recorded the instant it happens**, at midnight, but announced at
  8 AM. The streak shouldn't depend on anyone being awake to hear about it.
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

## Deploying

There are two supported targets. They share all the logic in `lib/` and differ
only in how state is stored and how the clock is driven.

### Netlify (already provisioned)

The `neverforget-timesheet` project exists, and every environment variable
(VAPID keys, session secret, both access codes, timezone) is already set on it.
All that remains is uploading the code:

```bash
git clone https://github.com/fahimworksfm/neverforget
cd neverforget
git checkout claude/timesheet-reminder-app-wpup7u
npm install
npx netlify deploy --prod --site 67d46c9c-7552-4c94-9b7d-17f39fce1d23
```

Or connect the repo in the Netlify UI (*Project configuration → Build & deploy →
Link repository*) so every push deploys automatically. Either way the settings
in `netlify.toml` are picked up.

**Environment variables must be created with scope `all`.** Scoped variables
(e.g. restricting one to `functions`) are a paid-plan feature; on the free tier
they are accepted by the API and then never exposed to the running function, so
every value reads as missing and the only visible symptom is a login that
rejects a correct code. `GET /api/session` reports which values resolve and
from where — check it first, before assuming a typo.

On this target:

- State lives in **Netlify Blobs** instead of SQLite, with strong consistency
  so a confirm is visible to the scheduler immediately.
- The scheduler is a **scheduled function** (`netlify/functions/tick.mts`)
  running every two minutes rather than an in-process timer. Scheduled
  functions only run on **published production deploys** — not previews.
- After the first deploy, log in as owner and set the timesheet URL, then hit
  **Send a test notification** to confirm delivery.

### Self-hosted

Needs an always-on Node process — the scheduler ticks every 60 seconds — so a
small VPS, Fly.io, Render, or Railway all work. Requirements:

- **HTTPS**, mandatory for service workers and push.
- A persistent volume mounted at `DATA_DIR` (default `./data`), or the SQLite
  history is lost on redeploy.
- Set `NODE_ENV=production` so session cookies are marked secure.

## Testing the ladder

Rather than waiting a week to find out whether it works:

```bash
npm run simulate            # nobody confirms — watch the full escalation
npm run simulate -- 20:30   # confirmed at 8:30 PM Friday — watch it stop
```

The argument is a 24-hour time, because it is a command-line flag; everything
the app *displays* is 12-hour.

This runs a real week through the real scheduler against a throwaway database
in `data/sim`, printing every notification it would send.

## Layout

```
lib/                Shared by both deployment targets
  escalation.js     The ladder — rungs, siege, quiet hours (pure)
  week.js           Timezone/DST math, deadlines, clock formatting (pure)
  auth.js           Session tokens, access codes (no ambient env reads)
  settings.js       Defaults, bounds, validation — one definition
  throttle.js       Per-client failed-attempt limiting

server/             Self-hosted target
  index.js          Express app, API, auth-gated routes
  scheduler.js      60s tick
  db.js             SQLite schema, settings, streaks
  push.js           Web push delivery, dead-subscription cleanup
  simulate.js       Accelerated week simulator

netlify/            Netlify target
  functions/api.mts   All /api/* routes
  functions/tick.mts  Scheduled function, every 2 minutes
  lib/store.mts       Blobs-backed state (strong consistency)
  lib/core.mts        buildState / confirm / runTick

public/             PWA: owner app, partner view, service worker
```

Everything in `lib/` is pure and takes the clock as an argument. That is what
lets the same ladder run under an in-process timer and a serverless cron
without branching, and what makes the simulator possible — a week can be
replayed at any speed without mocking timers.

## Settings

Editable in-app: timezone, timesheet URL, stake amount and recipient, siege and
weekend intervals, quiet hours, grace period, display names.
