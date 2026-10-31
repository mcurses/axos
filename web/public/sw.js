// The page's service worker: it exists for pushes only (no caching, so the app is never stale). A push from the hub is
// shown as a notification that opens the item on the page; its tag lets the hub's "answered" notice replace the
// question. Every push shows a notification: iOS withdraws push permission from a web app that stays silent.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: "AXOS", body: e.data ? e.data.text() : "" }; }
  const open = typeof p.open === "number" ? p.open : null;
  const show = self.registration.showNotification(p.title || "AXOS", {
    body: p.body || "",
    tag: p.tag || undefined,
    data: { url: p.url || "/ui/" },
    icon: "/ui/icon-192.png",
    badge: "/ui/icon-192.png",
    silent: p.priority === "low",
    renotify: false,
  });
  const badge = open !== null && navigator.setAppBadge ? (open > 0 ? navigator.setAppBadge(open) : navigator.clearAppBadge()).catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([show, badge]));
});

// Open the item: an open page of ours is focused and told where to go; else a new one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/ui/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const page = list.find((c) => "focus" in c);
    if (page) return page.navigate(url).then((c) => (c || page).focus()).catch(() => page.focus());
    return self.clients.openWindow(url);
  }));
});
