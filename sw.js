/* Presso Center — service worker de l'espace de gestion.
   Il ne sert qu'aux notifications : aucune page n'est mise en cache, le site
   reste toujours à jour. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Seules les adresses du site peuvent être ouvertes depuis une notification
function safeUrl(url) {
  try {
    const u = new URL(url || '/gestion.html', self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + '/gestion.html';
  } catch (e) {
    return self.location.origin + '/gestion.html';
  }
}

async function tellWindows(message) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach((c) => c.postMessage(message));
  return list;
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { body: e.data ? e.data.text() : '' };
  }
  const url = safeUrl(d.url);
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Presso Center', {
      body: d.body || '',
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-96.png',
      tag: d.tag || undefined,
      data: { url }
    });
    // l'application ouverte se met à jour sans attendre
    await tellWindows({ type: 'presso-push', url, clicked: false });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = safeUrl(e.notification.data && e.notification.data.url);
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find((c) => new URL(c.url).pathname.endsWith('/gestion.html'));
    if (open) {
      open.postMessage({ type: 'presso-push', url, clicked: true });
      return open.focus();
    }
    return self.clients.openWindow(url);
  })());
});
