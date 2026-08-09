const $ = (id) => document.getElementById(id);
let state = null;

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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), body);
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

function render() {
  const { week, pressure, streak, best, stakes, names } = state;
  document.body.dataset.pressure = String(pressure.level);
  $('pressurePill').textContent = pressure.label;

  const owner = names.owner;
  if (week.status === 'confirmed') {
    $('status').textContent = 'Submitted ✅';
    $('heroSub').textContent = week.onTime
      ? `${owner} submitted ${week.label} on time.`
      : `${owner} submitted ${week.label}, late.`;
  } else if (week.hoursLeft <= 0) {
    $('status').textContent = 'Missed ✕';
    $('heroSub').textContent = `${week.label} closed unsubmitted.`;
  } else {
    const h = Math.floor(week.hoursLeft);
    $('status').textContent = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h left`;
    $('heroSub').textContent = `${owner} has not submitted ${week.label} yet.`;
  }

  $('nudgeBtn').classList.toggle('hide', week.status === 'confirmed');
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
      return `<div class="chip ${cls}">${w.label.split(', ')[1] || w.label}<br>${mark}</div>`;
    })
    .join('');

  const owed = stakes.ledger.filter((s) => s.status === 'owed');
  $('stakesCard').classList.toggle('hide', !stakes.enabled);
  $('ledger').innerHTML = owed.length
    ? owed
        .map(
          (s) =>
            `<div class="row"><span class="k">${s.week}</span>` +
            `<span class="v">$${s.amount} <button class="btn secondary" style="display:inline-block;width:auto;padding:5px 12px;margin:0 0 0 8px;font-size:12px" data-settle="${s.week}">Settle</button></span></div>`
        )
        .join('') + `<div class="row"><span class="k">Total</span><span class="v">$${stakes.outstanding}</span></div>`
    : '<div class="muted">Nothing outstanding.</div>';

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
  el.textContent = on ? 'On ✅' : Notification.permission === 'denied' ? 'Blocked' : 'Off';
  $('enableBtn').classList.toggle('hide', on);
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
  } catch {
    err.textContent = 'That code did not work.';
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
