/* Service worker — מאפשר להציג התראות (בעיקר באנדרואיד ובאייפון כשהאתר נוסף למסך הבית) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(w => w.url.split('#')[0] === url.split('#')[0]);
    return c ? c.focus() : self.clients.openWindow(url);
  }));
});
