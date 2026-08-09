const $ = (id) => document.getElementById(id);

let state = null;
let ticker = null;

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
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
  if (ticker) clearInterval(ticker);
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
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render() {
  if (!state) return;
  const { week, pressure, streak, best, stakes, timesheetUrl } = state;

  document.body.dataset.pressure = String(pressure.level);
  $('pressurePill').textContent = pressure.label;

  const confirmed = week.status === 'confirmed';
  const overdue = week.hoursLeft <= 0;

  if (confirmed) {
    $('heroLabel').textContent = 'This week';
    $('countdown').textContent = 'Done ✅';
    $('countdown').classList.add('small');
    $('heroSub').textContent = week.onTime
      ? `${week.label} submitted on time. Nothing until next Friday.`
      : `${week.label} submitted late — but submitted.`;
    $('confirmBtn').classList.add('hide');
    $('undoBtn').classList.remove('hide');
  } else {
    $('countdown').classList.toggle('small', overdue);
    $('heroLabel').textContent = overdue ? 'Overdue by' : 'Time left to submit';
    $('countdown').textContent = formatCountdown(week.hoursLeft);
    $('heroSub').textContent = overdue
      ? `${week.label} closed unsubmitted. Still has to be done.`
      : `Due before Saturday · ${week.label}`;
    $('confirmBtn').classList.remove('hide');
    $('undoBtn').classList.add('hide');
  }

  const link = $('openSheet');
  if (timesheetUrl) {
    link.href = timesheetUrl;
    link.classList.remove('hide');
  } else {
    link.classList.add('hide');
  }

  $('streak').textContent = streak;
  $('best').textContent = best;
  $('nudges').textContent = week.nudgeCount;

  $('weeks').innerHTML = state.history
    .slice()
    .reverse()
    .map((w) => {
      const cls =
        w.status === 'confirmed' ? (w.onTime ? 'ontime' : 'late') : w.status === 'missed' ? 'missed' : '';
      const mark = w.status === 'confirmed' ? (w.onTime ? '✓' : '~') : w.status === 'missed' ? '✕' : '·';
      return `<div class="chip ${cls}" title="${w.label} — ${w.status}">${w.label.split(', ')[1] || w.label}<br>${mark}</div>`;
    })
    .join('');

  $('stakesCard').classList.toggle('hide', !stakes.enabled);
  $('stakeAmount').textContent = `$${stakes.amount}`;
  $('stakeOwed').textContent = `$${stakes.outstanding}`;
  $('stakeTo').textContent = stakes.recipient;

  $('iosBanner').classList.toggle('hide', !(isIOS && !isStandalone));
}

// Re-render the countdown locally each second, so the number moves without
// hammering the server; real state is refreshed on a slower cadence.
function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (!state) return;
    const deadline = new Date(state.week.deadline).getTime();
    state.week.hoursLeft = (deadline - Date.now()) / 3_600_000;
    render();
  }, 1000);
}

async function refresh() {
  state = await api('/api/state');
  render();
  fillSettings();
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

function fillSettings() {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([state.timezone, local, ...ZONES].filter(Boolean))];
  $('tz').innerHTML = zones.map((z) => `<option value="${z}">${z}</option>`).join('');
  $('tz').value = state.timezone;
  $('url').value = state.timesheetUrl || '';
  $('stakesOn').value = state.stakes.enabled ? '1' : '0';
  $('amount').value = state.stakes.amount;
  $('recipient').value = state.stakes.recipient;
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
  el.textContent = on ? 'On ✅' : Notification.permission === 'denied' ? 'Blocked' : 'Off';
  $('notifBanner').classList.toggle('hide', on);
  $('enableBtn').classList.toggle('hide', on);
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

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('Notifications were not granted. The app cannot remind you without them.');
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const { key } = await api('/api/vapid');
  if (!key) {
    alert('Server is missing its VAPID keys. Run `npm run keys` and restart.');
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
  alert('Notifications are on. Try the test button to see what Friday looks like.');
}

// ---------------------------------------------------------------- wiring

$('loginBtn').onclick = async () => {
  const code = $('code').value.trim();
  const err = $('loginError');
  err.classList.add('hide');
  try {
    const { role } = await api('/api/login', { method: 'POST', body: JSON.stringify({ code }) });
    if (role === 'partner') {
      window.location.href = '/partner';
      return;
    }
    showApp();
    await refresh();
    startTicker();
  } catch {
    err.textContent = 'That code did not work.';
    err.classList.remove('hide');
  }
};

$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

$('confirmBtn').onclick = async () => {
  $('confirmBtn').disabled = true;
  try {
    state = await api('/api/confirm', { method: 'POST', body: '{}' });
    render();
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
  if (!configured) alert('Server has no VAPID keys — nothing was sent. Run `npm run keys`.');
  else if (!delivered) alert('No devices registered yet. Tap "Enable on this device" first.');
};

$('saveBtn').onclick = async () => {
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
  $('saved').classList.remove('hide');
  setTimeout(() => $('saved').classList.add('hide'), 2500);
  await refresh();
};

$('logout').onclick = async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST', body: '{}' });
  showLogin();
};

// ---------------------------------------------------------------- boot

(async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    const { role } = await api('/api/session');
    if (role === 'partner') {
      window.location.href = '/partner';
      return;
    }
    if (!role) return showLogin();
    showApp();
    await refresh();
    startTicker();
    setInterval(() => refresh().catch(() => {}), 60_000);
  } catch {
    showLogin();
  }
})();
