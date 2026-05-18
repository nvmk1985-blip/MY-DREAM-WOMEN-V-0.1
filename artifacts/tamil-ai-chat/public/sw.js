self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'My AI Girls', body: event.data.text() }; }
  const title = data.title || 'My AI Girls ☁️';
  const options = {
    body: data.body || 'உன்னோட message-கு wait பண்றேன் 💬',
    icon: data.icon || '/icon.png',
    badge: data.badge || '/icon.png',
    data: { personaId: data.personaId || '' },
    vibrate: [200, 100, 200],
    tag: 'mygirls-' + (data.personaId || 'general'),
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const personaId = event.notification.data?.personaId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url && 'focus' in client) {
          client.focus();
          if (personaId) {
            client.postMessage({ type: 'OPEN_CHAT', personaId });
          }
          return;
        }
      }
      const url = self.registration.scope;
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
