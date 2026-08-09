const $ = (id) => document.getElementById(id);
let state = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only bounce to login for an expired session, never for a failed login
    // attempt -- otherwise the form resets before the error can be read.
    if (res.status === 401 && !path.endsWith('/login')) showLogin();
    throw Object.assign(new Error(body.error || res.statusText), body, { status: res.status });
  }
  return body;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

function showLogin() {
  $('login').classList.remove('hide');
  $('app').classList.add('hide');
}

// Fraction of Friday still available, 0..1. Drives the arc.
function remainingFraction(week) {
  if (week.status === 'confirmed') return 1;
  if (week.hoursLeft <= 0) return 0;
  if (week.minutesIntoFriday < 0) return 1;
  return Math.max(0, Math.min(1, 1 - week.minutesIntoFriday / 1440));
}

function drawDial(fraction) {
  const el = $('dialFill');
  const r = Number(el.getAttribute('r'));
  const c = 2 * Math.PI * r;
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c * (1 - fraction));
}

function render() {
  const { week, pressure, streak, best, stakes, names } = state;
  document.body.dataset.pressure = String(pressure.level);
  $('pressurePill').textContent = pressure.label;

  const owner = names.owner;
  if (week.status === 'confirmed') {
    $('status').textContent = 'Submitted';
    $('heroSub').textContent = week.onTime
      ? `${owner} submitted ${week.label} on time.`
      : `${owner} submitted ${week.label}, late.`;
  } else if (week.hoursLeft <= 0) {
    $('status').textContent = 'Missed';
    $('heroSub').textContent = `${week.label} closed unsubmitted.`;
  } else {
    const h = Math.floor(week.hoursLeft);
    $('status').textContent = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h left`;
    $('heroSub').textContent = `${owner} has not submitted ${week.label} yet.`;
  }
  drawDial(remainingFraction(week));

  $('nudgeBtn').classList.toggle('hide', week.status === 'confirmed');
  $('streak').textContent = streak;
  $('best').textContent = best;
  $('nudges').textContent = week.nudgeCount;

  $('weeks').innerHTML = state.history
    .map((w) => {
      const s = w.status === 'confirmed' ? (w.onTime ? 'ontime' : 'late') : w.status;
      return `<div class="hbar" data-s="${s}" title="${w.label} — ${s}"></div>`;
    })
    .join('');
  const short = (l) => (l || '').replace(/^\w+,\s*/, '');
  $('histFrom').textContent = state.history.length ? short(state.history[0].label) : '';
  $('histTo').textContent = state.history.length
    ? short(state.history[state.history.length - 1].label)
    : '';

  const owed = stakes.ledger.filter((s) => s.status === 'owed');
  $('stakesCard').classList.toggle('hide', !stakes.enabled);
  $('ledger').innerHTML = owed.length
    ? owed
        .map(
          (s) =>
            `<div class="row"><span class="row-k">${s.week}</span>` +
            `<span class="row-v">$${s.amount} <button class="btn btn-ghost btn-sm" style="margin-left:8px" data-settle="${s.week}">Settle</button></span></div>`
        )
        .join('') +
      `<div class="row"><span class="row-k">Total</span><span class="row-v">$${stakes.outstanding}</span></div>`
    : '<div class="hint">Nothing outstanding.</div>';

  for (const btn of document.querySelectorAll('[data-settle]')) {
    btn.onclick = async () => {
      state = await api(`/api/stakes/${btn.dataset.settle}/settle`, { method: 'POST', body: '{}' });
      render();
    };
  }

  $('iosBanner').classList.toggle('hide', !(isIOS && !isStandalone));
}

async function refresh() {
  state = await api('/api/state');
  render();
  updateNotifState();
}

async function updateNotifState() {
  const el = $('notifState');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    el.textContent = 'Not supported';
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const on = Notification.permission === 'granted' && Boolean(sub);
  el.textContent = on ? 'On' : Notification.permission === 'denied' ? 'Blocked' : 'Off';
  $('enableBtn').classList.toggle('hide', on);
  if (!on) $('notifPanel').open = true;
}

async function enablePush() {
  if (isIOS && !isStandalone) {
    alert('On iPhone: tap Share → Add to Home Screen, then open it from there.');
    return;
  }
  if ((await Notification.requestPermission()) !== 'granted') return;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('/api/vapid');
  if (!key) {
    alert('Server is missing VAPID keys.');
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
}

$('loginBtn').onclick = async () => {
  const err = $('loginError');
  err.classList.add('hide');
  try {
    const { role } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ code: $('code').value.trim() }),
    });
    if (role === 'owner') {
      window.location.href = '/';
      return;
    }
    $('login').classList.add('hide');
    $('app').classList.remove('hide');
    await refresh();
  } catch (e) {
    err.textContent =
      e.error === 'codes_not_configured'
        ? 'The server cannot see its access codes. Check the Netlify environment variables.'
        : e.status === 401
          ? 'That code did not work.'
          : `Login failed (HTTP ${e.status || '?'}).`;
    err.classList.remove('hide');
  }
};

$('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

$('nudgeBtn').onclick = async () => {
  const msg = $('nudgeMsg');
  msg.classList.remove('hide');
  try {
    const { delivered } = await api('/api/nudge', { method: 'POST', body: '{}' });
    msg.textContent = delivered ? 'Nudge sent.' : 'No devices registered on her side yet.';
  } catch (err) {
    msg.textContent =
      err.error === 'rate_limited'
        ? `Already nudged recently — try again in ${err.retryInMinutes} min.`
        : err.error === 'already_confirmed'
          ? 'She already submitted it.'
          : 'Could not send.';
  }
  setTimeout(() => msg.classList.add('hide'), 4000);
};

$('reveal').onclick = () => {
  const f = $('code');
  const hidden = f.type === 'password';
  f.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
};

$('enableBtn').onclick = enablePush;
$('testBtn').onclick = async () => {
  const { delivered, configured } = await api('/api/test-push', { method: 'POST', body: '{}' });
  if (!configured) alert('Server has no VAPID keys.');
  else if (!delivered) alert('Enable notifications on this device first.');
};
$('logout').onclick = async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST', body: '{}' });
  showLogin();
};

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    const { role } = await api('/api/session');
    if (role === 'owner') {
      window.location.href = '/';
      return;
    }
    if (!role) return showLogin();
    $('login').classList.add('hide');
    $('app').classList.remove('hide');
    await refresh();
    setInterval(() => refresh().catch(() => {}), 60_000);
  } catch {
    showLogin();
  }
})();
