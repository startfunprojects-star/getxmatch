'use strict';

// getxmatch service worker: only Web Push. It puts a badge / dot on the
// installed app's icon and shows a notification for a new message, quiz or
// poll (see src/push.js). Nothing is cached; the app always loads fresh.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function setBadge(count) {
  if (!self.navigator || !self.navigator.setAppBadge) return Promise.resolve();
  // Something new always arrived, so show at least a dot.
  return (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.setAppBadge()).catch(() => {});
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_e) { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await setBadge(d.badge || 0);
    // The app is open and on screen: it shows the message itself.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'getxmatch', {
      body: d.body || '',
      icon: '/assets/icon-192.png',
      badge: '/favicon-48.png',
      tag: d.tag || 'getxmatch',
      renotify: true,
      data: { url: d.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (url !== self.location.origin + '/' && win.navigate) await win.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
