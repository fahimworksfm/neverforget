const $ = (id) => document.getElementById(id);

let state = null;
let ticker = null;
let poller = null;

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry status and server error code so callers can tell a rejected
    // password from a misconfigured server. Collapsing both into one message
    // makes a broken deployment indistinguishable from a typo.
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    err.code = body.error;
    err.retryInSeconds = body.retryInSeconds;
    // Only bounce to login for an expired session, never for a failed login
    // attempt -- that would wipe the form mid-diagnosis.
    if (res.status === 401 && !path.endsWith('/login')) showLogin();
    throw err;
  }
  return body;
}

function loginErrorMessage(err) {
  if (err.code === 'codes_not_configured') {
    return 'The server cannot see its access codes. Check the Netlify environment variables.';
  }
  if (err.code === 'locked_out') {
    const mins = Math.ceil((err.retryInSeconds || 60) / 60);
    return `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
  if (err.status === 401) return 'That code did not work.';
  if (err.status) return `Login failed (HTTP ${err.status}).`;
  return 'Could not reach the server.';
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// ---------------------------------------------------------------- views

function showLogin() {
  $('login').classList.remove('hide');
  $('app').classList.add('hide');
  stopLive();
}

function showApp() {
  $('login').classList.add('hide');
  $('app').classList.remove('hide');
}

function formatCountdown(hours) {
  const total = Math.abs(Math.round(hours * 3600));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// The poster number: one unit, as large as the screen allows. The precise
// h:mm:ss lives in the small line under it.
function bigCountdown(hours) {
  const mins = Math.max(0, Math.ceil(hours * 60));
  if (hours >= 48) {
    const d = Math.floor(hours / 24);
    return [String(d), 'Days left'];
  }
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    return [String(h), h === 1 ? 'Hour left' : 'Hours left'];
  }
  return [String(mins), mins === 1 ? 'Minute.' : 'Minutes.'];
}

// Fraction of Friday still available, 0..1. Drives the ring.
function remainingFraction(week) {
  // A resolved week shows a full ring; an empty one reads as "you ran out".
  if (week.status === 'confirmed' || week.status === 'skipped') return 1;
  if (week.hoursLeft <= 0) return 0;
  if (week.minutesIntoDueDay < 0) return 1;
  return Math.max(0, Math.min(1, 1 - week.minutesIntoDueDay / 1440));
}

function drawRing(fraction) {
  const el = $('ringFill');
  const c = 2 * Math.PI * Number(el.getAttribute('r'));
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c * (1 - fraction));
  // A round cap leaves a dot on an empty ring; hide it.
  el.style.opacity = fraction > 0 ? '1' : '0';
}

// ?mood=0..5 or ?mood=done previews a colour without waiting for Friday.
const MOOD = new URLSearchParams(location.search).get('mood');

function setHero(big, unit, line, kind) {
  const el = $('bigNum');
  el.textContent = big;
  el.classList.toggle('is-word', kind === 'word');
  el.classList.toggle('is-long', kind === 'long');
  $('bigUnit').textContent = unit;
  $('heroLine').textContent = line;
}

function renderHistory(history) {
  ui.renderWeeks($('weeks'), history, (w) => ui.weekSheet(w, { onMarkHoliday: markHoliday }));
}

// A missed week that was really a day off. Returns true when it landed, so
// the sheet knows to close.
async function markHoliday(w) {
  try {
    state = await api(`/api/weeks/${w.key}/holiday`, { method: 'POST', body: '{}' });
    render();
    ui.toast(`${w.label} is now a holiday. The miss is off the record.`, { kind: 'ok' });
    return true;
  } catch (e) {
    ui.toast(`Could not change that week (${e.code || e.status || 'no connection'}).`, { kind: 'bad' });
    return false;
  }
}

// What happens next, in one line: the next rung of the ladder while there is
// one, the siege after that. Times come from the server's ladder, never from
// text restated here.
function nextReminderText(week, holiday, ladder) {
  const due = week.dueDate
    ? new Date(`${week.dueDate}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })
    : 'Friday';
  if (holiday?.soften) return `A gentle reminder or two, no penalty · ${week.label}`;
  const rungs = (ladder || []).filter((r) => r.at != null).sort((a, b) => a.at - b.at);
  if (week.minutesIntoDueDay < 0) {
    return rungs.length
      ? `Reminders start ${due} at ${rungs[0].clock} · due by midnight`
      : `Due by midnight on ${due}`;
  }
  if (week.minutesIntoDueDay >= week.siegeBeginsAt) {
    return 'Reminders every few minutes until you confirm';
  }
  const next = rungs.find((r) => r.at > week.minutesIntoDueDay);
  return next ? `Next reminder at ${next.clock} · due by midnight` : 'Due by midnight tonight';
}

function render() {
  if (!state) return;
  const { week, pressure, streak, best, stakes, timesheetUrl } = state;

  const confirmed = week.status === 'confirmed';
  const skipped = week.status === 'skipped';
  const overdue = week.hoursLeft <= 0;

  // The ground colour is the pressure; a resolved week overrides the clock.
  let level = String(pressure.level);
  let mode = confirmed ? 'done' : skipped ? 'holiday' : overdue ? 'over' : 'open';
  if (MOOD === 'done') mode = 'done';
  else if (MOOD !== null && /^[0-5]$/.test(MOOD)) {
    level = MOOD;
    if (mode !== 'open' && mode !== 'over') mode = 'open';
  }
  document.body.dataset.pressure = level;
  document.body.dataset.state = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', getComputedStyle(document.body).getPropertyValue('--bg').trim());
  $('pressurePill').textContent = pressure.label;

  $('countdown').textContent = formatCountdown(week.hoursLeft);
  $('heroClock').classList.toggle('is-idle', confirmed || skipped);

  if (skipped) {
    setHero('Holiday', '', '', 'long');
    $('heroSub').textContent = `${week.label} was a holiday. Nothing owed, streak untouched.`;
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  } else if (confirmed) {
    setHero('Done.', '', '', 'word');
    $('heroSub').textContent = week.onTime
      ? `${week.label} submitted on time. Nothing until next Friday.`
      : `${week.label} submitted late — but submitted.`;
    $('confirmBtn').classList.add('hide');
    $('undoBtn').classList.remove('hide');
  } else if (overdue) {
    setHero(
      'Missed.',
      '',
      week.status === 'missed' ? 'Streak reset to zero.' : 'Still has to be done.',
      'long'
    );
    $('heroLabel').textContent = 'Overdue by';
    $('heroSub').textContent = `${week.label} closed unsubmitted. It still has to be done.`;
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  } else {
    const [big, unit] = bigCountdown(week.hoursLeft);
    setHero(big, unit, pressure.level >= 4 ? 'Politeness is over.' : '', 'number');
    $('heroLabel').textContent = 'Time left';
    $('heroSub').textContent = nextReminderText(week, state.holiday, state.ladder);
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  }

  drawRing(remainingFraction(week));

  const link = $('openSheet');
  link.classList.toggle('hide', !timesheetUrl);
  if (timesheetUrl) link.href = timesheetUrl;
  // Without a link there is only one step, so it loses its number.
  $('steps').classList.toggle('no-link', !timesheetUrl || confirmed);

  $('streak').textContent = streak;
  $('best').textContent = best;
  $('nudges').textContent = week.nudgeCount;
  $('nudgesLabel').textContent = week.nudgeCount === 1 ? 'nudge so far' : 'nudges so far';

  renderHistory(state.history);

  $('stakesCard').classList.toggle('hide', !stakes.enabled);
  $('stakeAmount').textContent = `$${stakes.amount}`;
  $('stakeOwed').textContent = `$${stakes.outstanding}`;
  $('stakeTo').textContent = stakes.recipient;

  renderHolidayBanner(state.holiday, week);
  $('iosBanner').classList.toggle('hide', !(isIOS && !isStandalone));
}

function renderHolidayBanner(holiday, week) {
  const el = $('holidayBanner');
  if (!holiday?.name) {
    el.classList.add('hide');
    return;
  }
  const dueLabel = new Date(`${week.dueDate}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  el.innerHTML =
    holiday.shiftDays < 0
      ? `<b>${holiday.name}</b> falls on this week's Friday, so the timesheet is
         being treated as due <b>${dueLabel}</b>. Change that under Settings.`
      : `<b>${holiday.name}</b> falls on this week's Friday. Reminders are
         reduced and this week will not count against the streak.`;
  el.classList.remove('hide');
}

// Re-render the countdown locally each second so the number moves without
// hammering the server; real state refreshes on a slower cadence.
//
// Both timers are installed here, by every path that reaches a logged-in
// state. Installing the poll only in the boot path meant logging in via the
// form left the page frozen on its first response.
function startLive() {
  stopLive();
  ticker = setInterval(() => {
    if (!state) return;
    state.week.hoursLeft = (new Date(state.week.deadline).getTime() - Date.now()) / 3_600_000;
    render();
  }, 1000);
  poller = setInterval(() => refresh().catch(() => {}), 60_000);
}

function stopLive() {
  if (ticker) clearInterval(ticker);
  if (poller) clearInterval(poller);
  ticker = null;
  poller = null;
}

async function refresh() {
  state = await api('/api/state');
  render();
  // Only repopulate settings when they are not being edited -- the 60s poll
  // used to overwrite half-typed input once a minute.
  if (!settingsDirty) fillSettings();
  fillPreviewStages(state.ladder);
  updateNotifState();
}

// ---------------------------------------------------------------- settings

const ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'Europe/London', 'Europe/Dublin', 'Europe/Amsterdam',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Asia/Dubai',
  'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney', 'UTC',
];

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Settings save themselves. Choices (switches, the holiday options, the
// stepper) save at once; typed fields save a moment after the typing stops.
// While a change is unsaved the minute poll leaves the form alone, so it can
// never overwrite half-typed input.
let settingsDirty = false;
let saveTimer = null;

function settingsPatch() {
  return {
    timezone: $('tz').value,
    timesheet_url: $('url').value.trim(),
    stakes_enabled: $('stakesOn').checked ? '1' : '0',
    stakes_amount: String(Math.max(0, Math.round(Number($('amount').value) || 0))),
    stakes_recipient: $('recipient').value.trim(),
    holiday_handling: document.querySelector('input[name="holidayHandling"]:checked')?.value || 'soften',
    holiday_country: $('holidayCountry').value.trim().toUpperCase(),
  };
}

function markSaved(text) {
  $('savedMark').textContent = text;
}

async function saveSettings() {
  clearTimeout(saveTimer);
  markSaved('Saving…');
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(settingsPatch()) });
    // Only drop the dirty flag once the values are actually stored, so a
    // failed save cannot be quietly overwritten by the poller.
    settingsDirty = false;
    markSaved('✓ Saved');
    await refresh();
  } catch (e) {
    markSaved('');
    const why = {
      bad_holiday_country: 'The country needs two letters, like US or GB.',
      bad_stakes_amount: 'The stake needs to be a whole number.',
      bad_timezone: 'That timezone was not recognised.',
    }[e.code];
    ui.toast(why || `Not saved (${e.code || e.status || 'no connection'}). Your changes are still here.`, {
      kind: 'bad',
      action: { label: 'Retry', run: saveSettings, countdown: false },
      seconds: 8,
    });
  }
}

function scheduleSave(delay) {
  settingsDirty = true;
  markSaved('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, delay);
}

// Typed fields wait for a pause; everything else saves straight away. Country
// waits for both letters.
const TYPED = new Set(['url', 'recipient', 'amount', 'holidayCountry']);
for (const evt of ['input', 'change']) {
  $('settingsPanel').addEventListener(evt, (e) => {
    const t = e.target;
    if (!t?.id && t?.name !== 'holidayHandling') return;
    if (t.id === 'holidayCountry' && t.value.trim().length !== 2) {
      settingsDirty = true;
      markSaved('');
      return;
    }
    if (TYPED.has(t.id)) scheduleSave(evt === 'change' ? 0 : 900);
    else if (evt === 'change') scheduleSave(0);
    syncSettingsView();
  });
}

$('settingsPanel').addEventListener('click', (e) => {
  const step = e.target.closest?.('[data-step]');
  if (!step) return;
  const field = $('amount');
  field.value = String(Math.max(0, (Number(field.value) || 0) + Number(step.dataset.step)));
  scheduleSave(600);
});

$('tzChange').onclick = () => {
  const open = $('tzPick').classList.toggle('hide') === false;
  $('tzChange').setAttribute('aria-expanded', String(open));
  if (open) $('tz').focus();
};

$('tzUseLocal').onclick = () => {
  $('tz').value = LOCAL_TZ;
  scheduleSave(0);
  syncSettingsView();
};

function holidayHint() {
  const handling = document.querySelector('input[name="holidayHandling"]:checked')?.value || 'soften';
  const what = {
    soften: 'Two gentle reminders, no penalty.',
    shift: 'Everything runs a working day early.',
    off: 'Treated as an ordinary Friday.',
  }[handling];
  const h = state?.holiday;
  if (!h?.known) return `${what} Holiday dates load on the next scheduled check.`;
  if (!h.next) return `${what} No holiday Fridays coming up.`;
  const date = new Date(`${h.next.date}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `${what} Next holiday Friday: ${date} (${h.next.name}).`;
}

// Everything on the panel that follows from the values in it.
function syncSettingsView() {
  const tz = $('tz').value;
  $('tzText').textContent = `Midnight, ${tz.replace(/_/g, ' ')} time`;
  const differs = LOCAL_TZ && tz !== LOCAL_TZ;
  $('tzUseLocal').classList.toggle('hide', !differs);
  $('tzUseLocal').textContent = `Use this phone's timezone (${(LOCAL_TZ || '').replace(/_/g, ' ')})`;

  const url = $('url').value.trim();
  $('urlTest').classList.toggle('hide', !/^https?:\/\//i.test(url));
  $('urlTest').href = url || '#';

  $('stakesFields').classList.toggle('hide', !$('stakesOn').checked);
  $('holidayHint').textContent = holidayHint();
}

// Built from the ladder the server reports, never from hard-coded text. The
// old static list silently went stale the moment a rung moved.
function fillPreviewStages(ladder) {
  const select = $('previewStage');
  if (!ladder || select.dataset.filled === String(ladder.length)) return;
  const keep = select.value;
  select.replaceChildren(...ladder.map((s) => ui.el('option', { value: s.id }, `${s.clock} — ${s.label}`)));
  select.dataset.filled = String(ladder.length);
  select.value = keep && ladder.some((s) => s.id === keep) ? keep : 'hardstop';
}

function fillSettings() {
  const zones = [...new Set([state.timezone, LOCAL_TZ, ...ZONES].filter(Boolean))];
  $('tz').replaceChildren(...zones.map((z) => ui.el('option', { value: z }, z.replace(/_/g, ' '))));
  $('tz').value = state.timezone;
  $('url').value = state.timesheetUrl || '';
  $('stakesOn').checked = state.stakes.enabled;
  $('amount').value = state.stakes.amount;
  $('recipient').value = state.stakes.recipient;
  const handling = state.holiday?.handling || 'soften';
  for (const r of document.querySelectorAll('input[name="holidayHandling"]')) r.checked = r.value === handling;
  $('holidayCountry').value = state.holiday?.country || 'US';
  syncSettingsView();
}

// ---------------------------------------------------------------- push

async function updateNotifState() {
  const el = $('notifState');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    el.textContent = 'Not supported';
    $('notifBanner').classList.add('hide');
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const on = Notification.permission === 'granted' && Boolean(sub);
  el.textContent = on ? 'On' : Notification.permission === 'denied' ? 'Blocked' : 'Off';
  $('notifBanner').classList.toggle('hide', on);
  $('enableBtn').classList.toggle('hide', on);
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    ui.toast('This browser cannot show reminders. Try Safari or Chrome on the phone.', { kind: 'bad' });
    return;
  }
  if (isIOS && !isStandalone) {
    ui.toast('On iPhone, add this to the Home Screen first: Share → Add to Home Screen.', { kind: 'info', seconds: 8 });
    return;
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    ui.toast('Reminders were not allowed. Turn them on in the phone settings for this app.', { kind: 'bad', seconds: 8 });
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const { key } = await api('/api/vapid');
  if (!key) {
    ui.toast('The server is missing its notification keys.', { kind: 'bad' });
    return;
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  await api('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 80) }),
  });
  await updateNotifState();
  ui.toast('Reminders are on for this phone.', {
    kind: 'ok',
    action: { label: 'Send a test', run: sendTest, countdown: false },
    seconds: 8,
  });
}

// ---------------------------------------------------------------- wiring

$('loginBtn').onclick = async () => {
  const err = $('loginError');
  err.classList.add('hide');
  try {
    const { role } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ code: $('code').value.trim() }),
    });
    if (role === 'partner') {
      window.location.href = '/partner';
      return;
    }
    showApp();
    await refresh();
    startLive();
  } catch (e) {
    err.textContent = loginErrorMessage(e);
    err.classList.remove('hide');
  }
};

$('reveal').onclick = () => {
  const f = $('code');
  const hidden = f.type === 'password';
  f.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
};

$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

async function confirmSubmitted() {
  $('confirmBtn').disabled = true;
  const before = { streak: Number($('streak').textContent) };
  try {
    state = await api('/api/confirm', { method: 'POST', body: '{}' });
    render();
    window.release?.play(before);
    // A mis-tap is undone right here, without a second question.
    ui.toast('Recorded. Reminders stopped.', {
      kind: 'ok',
      action: { label: 'Undo', run: () => reopenWeek() },
      seconds: 8,
    });
  } catch (e) {
    // A confirm she believes landed but did not is the single worst failure
    // this app can have: the reminders stop in her head, not on the server.
    ui.toast(`Not recorded (${e.code || e.status || 'no connection'}). The week is still open.`, {
      kind: 'bad',
      action: { label: 'Retry', run: confirmSubmitted, countdown: false },
      seconds: 15,
    });
  } finally {
    $('confirmBtn').disabled = false;
  }
}

async function reopenWeek() {
  try {
    state = await api('/api/unconfirm', { method: 'POST', body: '{}' });
    render();
    ui.toast('Week reopened. Reminders will start again.', { kind: 'info' });
  } catch (e) {
    ui.toast(`Could not reopen the week (${e.code || e.status || 'no connection'}).`, { kind: 'bad' });
  }
}

async function sendTest() {
  try {
    const { delivered, configured } = await api('/api/test-push', { method: 'POST', body: '{}' });
    if (!configured) ui.toast('The server is missing its notification keys.', { kind: 'bad' });
    else if (!delivered) ui.toast('No phone is set up yet. Turn reminders on first.', { kind: 'info' });
    else ui.toast('Test sent. It should arrive in a few seconds.', { kind: 'ok' });
  } catch (e) {
    ui.toast(`Could not send (${e.code || e.status || 'no connection'}).`, { kind: 'bad' });
  }
}

$('confirmBtn').onclick = confirmSubmitted;

// Outside the few seconds after confirming, undo asks first: reopening a
// week starts the reminders again.
$('undoBtn').onclick = async () => {
  const yes = await ui.ask({
    title: 'Reopen this week?',
    body: 'The reminders start again until you confirm.',
    ok: 'Reopen it',
    cancel: 'Keep it done',
  });
  if (yes) reopenWeek();
};

$('enableBtn').onclick = enablePush;
$('notifTurnOn').onclick = enablePush;
$('testBtn').onclick = sendTest;

$('previewBtn').onclick = async () => {
  try {
    const { delivered } = await api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ stage: $('previewStage').value }),
    });
    ui.toast(
      delivered
        ? `Sent to ${delivered} phone${delivered === 1 ? '' : 's'}.`
        : 'No phone is set up yet. Turn reminders on first.',
      { kind: delivered ? 'ok' : 'info' }
    );
  } catch (e) {
    ui.toast(`Could not send (${e.code || e.status || 'network error'}).`, { kind: 'bad' });
  }
};

$('resetBtn').onclick = async () => {
  const yes = await ui.ask({
    title: 'Delete all history?',
    body: 'Every week and every stake is removed. Settings and phones are kept. This cannot be undone.',
    ok: 'Delete history',
    danger: true,
  });
  if (!yes) return;
  try {
    const { removed } = await api('/api/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'RESET' }),
    });
    ui.toast(`Cleared ${removed} record${removed === 1 ? '' : 's'}.`, { kind: 'ok' });
    await refresh();
  } catch (e) {
    ui.toast(`Could not clear history (${e.code || e.status || 'no connection'}).`, { kind: 'bad' });
  }
};

$('logout').onclick = async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST', body: '{}' });
  showLogin();
};

// ---------------------------------------------------------------- boot

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const { role } = await api('/api/session');
    if (role === 'partner') {
      window.location.href = '/partner';
      return;
    }
    if (!role) return showLogin();
    showApp();
    await refresh();
    startLive();
  } catch {
    showLogin();
  }
})();
