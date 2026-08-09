/* global self, clients */

const DEFAULT_PAYLOAD = {
  title: 'Timesheet',
  body: 'Unconfirmed.',
  url: '/',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = DEFAULT_PAYLOAD;
  try {
    if (event.data) data = { ...DEFAULT_PAYLOAD, ...event.data.json() };
  } catch {
    if (event.data) data = { ...DEFAULT_PAYLOAD, body: event.data.text() };
  }

  // Both escape hatches live on the notification itself, so the timesheet can
  // be opened -- or the week closed out -- without opening the app at all.
  const actions = data.stage
    ? [
        { action: 'open', title: 'Open timesheet' },
        { action: 'confirm', title: 'I submitted it' },
      ]
    : [];

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || 'timesheet',
      renotify: Boolean(data.renotify),
      requireInteraction: Boolean(data.requireInteraction),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      vibrate: data.requireInteraction ? [300, 120, 300, 120, 300] : [200],
      data: { url: data.url || '/', stage: data.stage, weekKey: data.weekKey },
      actions,
    })
  );
});

// Focus an existing window if there is one, but navigate it to the target
// first. Focusing alone would land her back on the app instead of the
// timesheet -- which is the one journey the notification exists to shorten.
async function focusApp(url) {
  const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (!c.url.startsWith(self.location.origin)) continue;
    if ('navigate' in c && url) {
      try {
        const navigated = await c.navigate(url);
        return (navigated || c).focus();
      } catch {
        // Cross-origin targets reject navigate(); fall back to a new window.
        return clients.openWindow(url);
      }
    }
    if ('focus' in c) return c.focus();
  }
  return clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const { url } = event.notification.data || {};
  event.notification.close();

  if (event.action === 'confirm') {
    event.waitUntil(
      fetch('/api/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then((res) => {
          if (!res.ok) throw new Error('confirm failed');
          return self.registration.showNotification('Confirmed ✅', {
            body: 'Logged. Reminders stop until next Friday.',
            tag: 'timesheet-confirmed',
            icon: '/icons/icon-192.png',
          });
        })
        .catch(() =>
          // Never silently swallow it -- a confirm she thinks landed but did
          // not would be the single worst failure this app could have.
          self.registration.showNotification('Could not confirm', {
            body: 'Tap to open the app and confirm there.',
            tag: 'timesheet-confirm-failed',
            requireInteraction: true,
            icon: '/icons/icon-192.png',
            data: { url: '/' },
          })
        )
    );
    return;
  }

  // Default tap and the explicit "open" action both go straight to the
  // timesheet, because the gap between intent and action is where this fails.
  event.waitUntil(focusApp(url || '/'));
});
