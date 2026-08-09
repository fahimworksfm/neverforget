// Walks a full week through the scheduler at accelerated speed so you can see
// exactly what the ladder does before trusting it with a real Friday.
//
//   npm run simulate            -- she never confirms
//   npm run simulate -- 16:30   -- she confirms at 16:30 on Friday
//
// Runs against a throwaway database in data/sim so it cannot touch real state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(__dirname, '..', 'data', 'sim');
fs.rmSync(SIM_DIR, { recursive: true, force: true });
process.env.DATA_DIR = SIM_DIR;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { setting, setSetting, getWeek, currentStreak } = await import('./db.js');
const { tick } = await import('./scheduler.js');
const { zonedToUtc, weekKeyFor, localParts } = await import('../lib/week.js');
const db = (await import('./db.js')).default;

const TZ = setting('timezone');
setSetting('stakes_enabled', '1');
setSetting('stakes_amount', '20');

const confirmArg = process.argv[2];
let confirmAtMinutes = null;
if (confirmArg && /^\d{1,2}:\d{2}$/.test(confirmArg)) {
  const [h, m] = confirmArg.split(':').map(Number);
  confirmAtMinutes = h * 60 + m;
}

// Pick the Friday of the current week and start the clock Friday 00:00 local.
const now = new Date();
const fridayKey = weekKeyFor(now, TZ, 4);
const [fy, fm, fd] = fridayKey.split('-').map(Number);
const start = zonedToUtc(fy, fm, fd, 0, 0, TZ);

console.log(`\n  Simulating week ${fridayKey}  (timezone ${TZ})`);
console.log(
  confirmAtMinutes === null
    ? '  Scenario: she never confirms.\n'
    : `  Scenario: she confirms at ${confirmArg} on Friday.\n`
);
console.log('  time                  event');
console.log('  ' + '-'.repeat(74));

const STEP_MINUTES = 5;
const TOTAL_MINUTES = 3 * 24 * 60; // Friday 00:00 through Sunday midnight.
let confirmed = false;
let fires = 0;

function stamp(date) {
  const p = localParts(date, TZ);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.weekday];
  return `${day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

for (let m = 0; m <= TOTAL_MINUTES; m += STEP_MINUTES) {
  const at = new Date(start.getTime() + m * 60_000);

  if (!confirmed && confirmAtMinutes !== null && m >= confirmAtMinutes) {
    const key = weekKeyFor(at, TZ, 4);
    db.prepare(
      "UPDATE weeks SET status = 'confirmed', confirmed_at = ?, on_time = 1 WHERE week_key = ?"
    ).run(at.toISOString(), key);
    confirmed = true;
    console.log(`  ${stamp(at).padEnd(20)}  ✅ CONFIRMED — reminders stop here`);
  }

  const result = await tick(at);
  if (result.action !== 'none') {
    fires += 1;
    const icon = result.action === 'missed' ? '🔴' : result.action === 'overdue' ? '🟠' : '🔔';
    console.log(`  ${stamp(at).padEnd(20)}  ${icon} ${result.action}: ${result.stage}`);
  }
}

const week = getWeek(fridayKey);
const owed = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM stakes WHERE status='owed'").get().t;

console.log('  ' + '-'.repeat(74));
console.log(`\n  Notifications fired: ${fires}`);
console.log(`  Final status:        ${week.status}`);
console.log(`  Streak:              ${currentStreak()}`);
console.log(`  Stakes owed:         $${owed}\n`);
