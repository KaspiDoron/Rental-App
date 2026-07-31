// WheelDeal service worker - Web Push only (kept intentionally minimal; no
// offline caching so there is nothing stale to invalidate). Shows a shop-reply
// notification even when the app is closed, and focuses/opens the app on tap.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "WheelDeal";
  const options = {
    body: data.body || "A rental shop just replied.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    // PER-SHOP COLLAPSE. One global tag meant a reply from shop B replaced the
    // unread notification from shop A - and the ingest-time alert plus the
    // later "price landed" upgrade for the SAME shop must collapse onto each
    // other, which only works if the tag identifies the shop.
    tag: data.tag || "wheeldeal-reply",
    renotify: true,
    data: { url: data.url || "/" },
  };
  // B8 stage 1: also wake any OPEN app tab so it refetches immediately, instead
  // of waiting out its own 6-15s poll (the "push says 1125, card says waiting"
  // desync). The page listens for this message and bumps its sync nonce.
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const client of list) {
          client.postMessage({ type: "wd-refresh", reason: "push", payload: data });
        }
      }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          // B8: prefer a cheap focus when the tab is already on the app - a full
          // navigate() remounts the whole app and re-runs every mount effect.
          // Only navigate when the client is on a different path.
          try {
            const sameApp = new URL(client.url).pathname === new URL(target, client.url).pathname;
            if (!sameApp && "navigate" in client) client.navigate(target);
          } catch (e) {
            /* URL parse guard - focus is enough */
          }
          client.postMessage({ type: "wd-refresh", reason: "notification-click" });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
