/**
 * Web push client. With API_BASE set, "Notify me" buttons register sw.js, ask for permission, subscribe with the
 * pad's VAPID key and store the subscription with its scope (seats, event types) at /v1/push/subscribe.
 * The scope lives in this browser too (localStorage 'twenty-push'), so the console can show and edit it.
 * Without API_BASE (the preview) the page falls back to an in-page sample notification.
 */
(function () {
  const cfg = window.TWENTY_CONFIG || {}; const base = String(cfg.API_BASE || "").replace(/\/$/, "");
  const live = Boolean(base) && (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base));
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const say = (m, k) => (typeof toast === "function" ? toast(m, k) : console.log(m));
  const KEY = "twenty-push";
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } };
  const keep = (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) {} };
  const b64 = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
  const api = (path, method, body) => fetch(base + path, { method, headers: { "content-type": "application/json", accept: "application/json" }, credentials: "omit", body: body ? JSON.stringify(body) : undefined }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
  let reg = null;
  async function registration() { if (reg) return reg; reg = await navigator.serviceWorker.register("sw.js?api=" + encodeURIComponent(base), { scope: "./" }); return reg; }

  async function subscribe(scope) {
    scope = scope || {}; const seats = (scope.seats || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 20).slice(0, 20); const events = (scope.events || []).slice(0, 20);
    if (!live) { return sample(); }
    if (!supported) { say("This browser cannot receive push. On iPhone, add the pad to the Home Screen first.", "warn"); return null; }
    if (location.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { say("Push needs the https site.", "warn"); return null; }
    const key = await api("/v1/push/key", "GET").catch(() => null); if (!key || !key.public_key) { say("Push is not switched on for this pad yet.", "warn"); return null; }
    const perm = await Notification.requestPermission(); if (perm !== "granted") { say("Notifications were not allowed.", "warn"); return null; }
    const r = await registration(); await navigator.serviceWorker.ready;
    let sub = await r.pushManager.getSubscription(); if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key.public_key) });
    const wallet = (typeof state !== "undefined" && state.wallet) || undefined;
    const res = await api("/v1/push/subscribe", "POST", { subscription: sub.toJSON(), seats, events, wallet });
    keep({ endpoint: sub.endpoint, seats, events, ts: Date.now() }); window.__twentyPushState = status();
    say(`Notifications on · ${seats.length ? seats.length + " seat" + (seats.length === 1 ? "" : "s") : "every seat"}.`, "good");
    document.dispatchEvent(new CustomEvent("twenty:push", { detail: status() }));
    return res;
  }
  async function unsubscribe() {
    const s = saved(); try { const r = await registration(); const sub = await r.pushManager.getSubscription(); if (sub) { if (live) await api("/v1/push/subscribe", "DELETE", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); } else if (s && live) await api("/v1/push/subscribe", "DELETE", { endpoint: s.endpoint }).catch(() => {}); } catch (e) {}
    keep(null); say("Notifications off.", ""); document.dispatchEvent(new CustomEvent("twenty:push", { detail: status() }));
  }
  async function test() { const s = saved(); if (!s || !live) return sample(); try { const r = await api("/v1/push/test", "POST", { endpoint: s.endpoint }); say(r.ok ? "Test notification sent." : "The push service did not accept it (" + (r.status || "?") + ").", r.ok ? "good" : "warn"); return r; } catch (e) { say(e.message, "warn"); return null; } }
  async function sample() {
    if (!("Notification" in window)) { say("This browser has no notifications.", "warn"); return null; }
    const perm = await Notification.requestPermission(); if (perm !== "granted") { say("Notifications were not allowed.", "warn"); return null; }
    try { new Notification("Seat 07 launches in 15 min", { body: "Sable · 14:30 UTC · the CA drops on the pad at launch, never before.", icon: "icons/icon-192.png", tag: "sample" }); say(live ? "Sample shown." : "Sample shown · real push works on the live site.", "good"); } catch (e) { say("Sample notification could not be shown here.", "warn"); }
    return null;
  }
  function status() { const s = saved(); return { live, supported, permission: "Notification" in window ? Notification.permission : "unsupported", on: Boolean(s), seats: s ? s.seats : [], events: s ? s.events : [], since: s ? s.ts : null }; }
  window.__twentyPush = { subscribe, unsubscribe, test, status, sample };
  window.__twentyPushState = status();
  // keep the server copy fresh when the browser rotated the subscription behind our back
  if (live && supported && saved()) registration().then((r) => r.pushManager.getSubscription()).then((sub) => { const s = saved(); if (sub && s && sub.endpoint !== s.endpoint) return api("/v1/push/subscribe", "POST", { subscription: sub.toJSON(), seats: s.seats, events: s.events }).then(() => keep({ ...s, endpoint: sub.endpoint })); }).catch(() => {});
})();
