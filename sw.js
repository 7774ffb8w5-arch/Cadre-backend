/* Cadre · service worker: web push only (no caching, the page is always fresh).
   Registered by web/push.js as sw.js?api=<API_BASE> so a renewed subscription can be re-registered from here. */
const API = new URL(self.location.href).searchParams.get("api") || "";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Cadre", body: e.data ? e.data.text() : "" }; }
  const title = String(d.title || "Cadre").slice(0, 80);
  e.waitUntil(self.registration.showNotification(title, { body: String(d.body || "").slice(0, 200), icon: d.icon || "/icons/icon-192.png", badge: d.badge || "/icons/icon-192.png", tag: d.tag ? String(d.tag).slice(0, 40) : undefined, renotify: Boolean(d.tag), data: { url: typeof d.url === "string" && /^(\/|https:\/\/)/.test(d.url) ? d.url : "/" }, timestamp: Date.now() }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) { if ("navigate" in c) c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
/* the push service rotated the subscription: subscribe again with the same key and tell the pad */
self.addEventListener("pushsubscriptionchange", (e) => {
  const old = e.oldSubscription; const key = old && old.options && old.options.applicationServerKey;
  if (!API || !key) return;
  e.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) =>
    fetch(API + "/v1/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), seats: [], events: [] }) })).catch(() => {}));
});
