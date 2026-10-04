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

// Fraction of Friday still available, 0..1. Drives the arc.
function remainingFraction(week) {
  // A skipped holiday week is resolved, not failed -- show a full ring rather
  // than the empty one that reads as "you ran out of time".
  if (week.status === 'confirmed' || week.status === 'skipped') return 1;
  if (week.hoursLeft <= 0) return 0;
  if (week.minutesIntoDueDay < 0) return 1;
  return Math.max(0, Math.min(1, 1 - week.minutesIntoDueDay / 1440));
}

function drawDial(fraction) {
  const el = $('dialFill');
  const r = Number(el.getAttribute('r'));
  const c = 2 * Math.PI * r;
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c * (1 - fraction));
}

function renderHistory(history) {
  const host = $('weeks');
  host.innerHTML = history
    .map((w) => {
      const s = w.status === 'confirmed' ? (w.onTime ? 'ontime' : 'late') : w.status;
      return `<div class="hbar" data-s="${s}" title="${w.label} — ${s}"></div>`;
    })
    .join('');
  const short = (l) => (l || '').replace(/^\w+,\s*/, '');
  $('histFrom').textContent = history.length ? short(history[0].label) : '';
  $('histTo').textContent = history.length ? short(history[history.length - 1].label) : '';
}

function render() {
  if (!state) return;
  const { week, pressure, streak, best, stakes, timesheetUrl } = state;

  document.body.dataset.pressure = String(pressure.level);
  $('pressurePill').textContent = pressure.label;

  const confirmed = week.status === 'confirmed';
  const skipped = week.status === 'skipped';
  const overdue = week.hoursLeft <= 0;
  const value = $('countdown');

  if (skipped) {
    $('heroLabel').textContent = 'This week';
    value.textContent = 'Holiday';
    value.classList.add('is-word');
    $('heroSub').textContent = `${week.label} was a holiday. Nothing owed, streak untouched.`;
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  } else if (confirmed) {
    $('heroLabel').textContent = 'This week';
    value.textContent = 'Done';
    value.classList.add('is-word');
    $('heroSub').textContent = week.onTime
      ? `${week.label} submitted on time. Nothing until next Friday.`
      : `${week.label} submitted late — but submitted.`;
    $('confirmBtn').classList.add('hide');
    $('undoBtn').classList.remove('hide');
  } else {
    value.classList.toggle('is-word', false);
    $('heroLabel').textContent = overdue ? 'Overdue by' : 'Time left to submit';
    value.textContent = formatCountdown(week.hoursLeft);
    $('heroSub').textContent = overdue
      ? `${week.label} closed unsubmitted. Still has to be done.`
      : `Due before Saturday · ${week.label}`;
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  }

  const fraction = remainingFraction(week);
  drawDial(fraction);
  window.ambience?.update({
    level: pressure.level,
    urgency: confirmed || skipped ? 0 : 1 - fraction,
    done: confirmed || skipped,
  });

  const link = $('openSheet');
  link.classList.toggle('hide', !timesheetUrl);
  if (timesheetUrl) link.href = timesheetUrl;

  $('streak').textContent = streak;
  $('best').textContent = best;
  $('nudges').textContent = week.nudgeCount;

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

const SETTING_FIELDS = ['tz', 'url', 'stakesOn', 'amount', 'recipient', 'holidayHandling', 'holidayCountry'];
let settingsDirty = false;

// One delegated listener. `change` matters as well as `input` because some
// browsers only fire `change` for <select>.
for (const evt of ['input', 'change']) {
  document.addEventListener(evt, (e) => {
    if (e.target && SETTING_FIELDS.includes(e.target.id)) settingsDirty = true;
  });
}

// Built from the ladder the server reports, never from hard-coded text. The
// old static list silently went stale the moment a rung moved.
function fillPreviewStages(ladder) {
  const select = $('previewStage');
  if (!ladder || select.dataset.filled === String(ladder.length)) return;
  const keep = select.value;
  select.innerHTML = ladder
    .map((s) => `<option value="${s.id}">${s.clock} — ${s.label}</option>`)
    .join('');
  select.dataset.filled = String(ladder.length);
  select.value = keep && ladder.some((s) => s.id === keep) ? keep : 'hardstop';
}

function fillSettings() {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([state.timezone, local, ...ZONES].filter(Boolean))];
  $('tz').innerHTML = zones.map((z) => `<option value="${z}">${z}</option>`).join('');
  $('tz').value = state.timezone;
  $('url').value = state.timesheetUrl || '';
  $('stakesOn').value = state.stakes.enabled ? '1' : '0';
  $('amount').value = state.stakes.amount;
  $('recipient').value = state.stakes.recipient;
  $('holidayHandling').value = state.holiday?.handling || 'soften';
  $('holidayCountry').value = state.holiday?.country || 'US';
  $('holidayHint').textContent = state.holiday?.known
    ? 'What to do when the Friday is a public holiday.'
    : 'Holiday data has not been fetched yet — it loads on the next scheduled check.';
}

// ---------------------------------------------------------------- push

async function updateNotifState() {
  const el = $('notifState');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    el.textContent = 'Not supported';
    $('notifBanner').classList.remove('hide');
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const on = Notification.permission === 'granted' && Boolean(sub);
  el.textContent = on ? 'On' : Notification.permission === 'denied' ? 'Blocked' : 'Off';
  $('notifBanner').classList.toggle('hide', on);
  $('enableBtn').classList.toggle('hide', on);
  // Surface the panel automatically while it still needs attention.
  if (!on) $('notifPanel').open = true;
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('This browser does not support push notifications.');
    return;
  }
  if (isIOS && !isStandalone) {
    alert('On iPhone: tap Share → Add to Home Screen, then open the app from there and try again.');
    return;
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    alert('Notifications were not granted. The app cannot remind you without them.');
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const { key } = await api('/api/vapid');
  if (!key) {
    alert('Server is missing its VAPID keys.');
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
  alert('Notifications are on. Try the preview to see what Friday looks like.');
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

$('confirmBtn').onclick = async () => {
  $('confirmBtn').disabled = true;
  try {
    state = await api('/api/confirm', { method: 'POST', body: '{}' });
    render();
  } catch (e) {
    // A confirm she believes landed but did not is the single worst failure
    // this app can have: the reminders stop in her head, not on the server.
    alert(
      `Could not record it (${e.code || e.status || 'no connection'}).\n\n` +
        'The week is still open. Try again once you are back online.'
    );
  } finally {
    $('confirmBtn').disabled = false;
  }
};

$('undoBtn').onclick = async () => {
  if (!confirm('Reopen this week? The reminders start again.')) return;
  state = await api('/api/unconfirm', { method: 'POST', body: '{}' });
  render();
};

$('enableBtn').onclick = enablePush;

$('testBtn').onclick = async () => {
  const { delivered, configured } = await api('/api/test-push', { method: 'POST', body: '{}' });
  if (!configured) alert('Server has no VAPID keys.');
  else if (!delivered) alert('No devices registered yet — enable notifications first.');
};

$('previewBtn').onclick = async () => {
  const msg = $('previewMsg');
  msg.classList.remove('hide');
  try {
    const { delivered } = await api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ stage: $('previewStage').value }),
    });
    msg.textContent = delivered
      ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'}.`
      : 'No devices registered yet — enable notifications first.';
  } catch (e) {
    msg.textContent = `Could not send (${e.code || e.status || 'network error'}).`;
  }
  setTimeout(() => msg.classList.add('hide'), 5000);
};

$('resetBtn').onclick = async () => {
  if (!confirm('Delete all week history and stakes? Settings and devices are kept.')) return;
  const { removed } = await api('/api/reset', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'RESET' }),
  });
  alert(`Cleared ${removed} record${removed === 1 ? '' : 's'}.`);
  await refresh();
};

$('saveBtn').onclick = async () => {
  const saved = $('saved');
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        timezone: $('tz').value,
        timesheet_url: $('url').value.trim(),
        stakes_enabled: $('stakesOn').value,
        stakes_amount: $('amount').value,
        stakes_recipient: $('recipient').value.trim(),
      }),
    });
    // Only drop the dirty flag once the values are actually stored. Clearing
    // it first meant a failed save let the poller quietly overwrite the form.
    settingsDirty = false;
    saved.textContent = 'Saved.';
    saved.className = 'notice notice-ok';
    await refresh();
  } catch (e) {
    saved.textContent = `Not saved (${e.code || e.status || 'no connection'}). Your changes are still here.`;
    saved.className = 'notice notice-bad';
  }
  saved.classList.remove('hide');
  setTimeout(() => saved.classList.add('hide'), 4000);
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
