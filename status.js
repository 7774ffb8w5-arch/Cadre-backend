(function () {
  "use strict";
  var API = (window.TWENTY_CONFIG && window.TWENTY_CONFIG.API_BASE) || "";
  var NAMES = { website: "Website", api: "API", database: "Database", scheduler: "Scheduler", chain: "Solana RPC", market: "Market data", leaderboard: "Daily leaderboard", payments: "Payments", alerts: "Alerts", program: "On-chain program" };
  var ORDER = ["website", "api", "database", "scheduler", "chain", "market", "leaderboard", "payments", "alerts", "program"];
  var LABEL = { operational: "Operational", degraded: "Degraded", down: "Down", off: "Not enabled yet", unknown: "Unknown" };
  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function ago(d) { var s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000); return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 172800 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; }
  function get(path) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 8000);
    return fetch(API + path, { signal: c.signal, cache: "no-store" }).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function sample() {
    var days = [], d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
    var comps = ["api", "database", "scheduler", "chain", "market", "leaderboard", "payments", "alerts", "program"];
    var daily = []; comps.forEach(function (c) { for (var i = 89; i >= 0; i--) { var d = new Date(d0 - i * 864e5).toISOString().slice(0, 10); daily.push({ day: d, component: c, ok: 1438, degraded: 2, total: 1440 }); } });
    return { overall: "operational", preview: true, generated_at: new Date().toISOString(), daily: daily, incidents: [], components: comps.map(function (c) { return { component: c, state: c === "program" || c === "payments" ? "off" : "operational", latency_ms: null, detail: c === "program" ? "not deployed yet" : c === "payments" ? "payments not configured" : "responding", since: new Date().toISOString() }; }) };
  }
  function bars(rows) {
    var map = {}; rows.forEach(function (r) { map[r.day] = r; });
    var wrap = el("div", "bars"), d0 = new Date(), good = 0, tot = 0; d0.setUTCHours(0, 0, 0, 0);
    for (var i = 89; i >= 0; i--) {
      var day = new Date(d0 - i * 864e5).toISOString().slice(0, 10), r = map[day], b = el("i");
      if (r && r.total) { var up = (r.ok + r.degraded) / r.total; good += r.ok + r.degraded; tot += r.total; b.className = up >= 0.999 && r.degraded / r.total < 0.05 ? "g" : up >= 0.98 ? "y" : "r"; b.title = day + " · " + (100 * up).toFixed(2) + " % up"; }
      else b.title = day + " · no data";
      wrap.appendChild(b);
    }
    return { node: wrap, pct: tot ? (100 * good / tot) : null };
  }
  function row(key, c, daily) {
    var box = el("div", "comp"), top = el("div", "top"), st = c ? c.state : "unknown";
    top.appendChild(el("div", "dot " + st)); top.appendChild(el("div", "nm", NAMES[key] || key)); top.appendChild(el("div", "st " + st, LABEL[st] + (c && c.latency_ms ? " · " + c.latency_ms + " ms" : "")));
    box.appendChild(top);
    if (c && c.detail) box.appendChild(el("div", "det", c.detail));
    if (st !== "off") { var b = bars(daily.filter(function (r) { return r.component === key; })); box.appendChild(b.node); var f = el("div", "foot"); f.appendChild(el("span", "", "90 days ago")); f.appendChild(el("span", "", b.pct == null ? "no data yet" : b.pct.toFixed(2) + " % uptime")); f.appendChild(el("span", "", "today")); box.appendChild(f); }
    return box;
  }
  function render(h, web) {
    var comps = {}; (h.components || []).forEach(function (c) { comps[c.component] = c; });
    comps.website = web;
    var all = $("comps"); all.textContent = "";
    var daily = (h.daily || []).slice(); if (web.state === "operational") { /* the website is probed by this page; its bar fills from visits only */ }
    ORDER.forEach(function (k) { if (k === "website") { var b = el("div", "comp"), t = el("div", "top"); t.appendChild(el("div", "dot " + web.state)); t.appendChild(el("div", "nm", "Website")); t.appendChild(el("div", "st " + web.state, LABEL[web.state] + (web.latency_ms ? " · " + web.latency_ms + " ms" : ""))); b.appendChild(t); b.appendChild(el("div", "det", web.detail)); all.appendChild(b); } else all.appendChild(row(k, comps[k], daily)); });
    var o = h.overall, t = { operational: "All systems operational", degraded: "Some systems are degraded", outage: "Service disruption", unknown: "Status data is not fresh" };
    if (web.state === "down") o = "outage";
    $("odot").className = "dot " + (o === "unknown" ? "" : o); $("otitle").textContent = t[o] || t.unknown;
    $("osub").textContent = o === "operational" ? "The website, API, scheduler and leaderboard are running normally." : o === "unknown" ? "The status probes have not reported in the last minutes." : "We are looking into it. Open incidents are listed below.";
    var inc = $("incs"); inc.textContent = "";
    if (!(h.incidents || []).length) inc.appendChild(el("p", "empty", "No incidents in the last 30 days."));
    (h.incidents || []).forEach(function (i) { var d = el("div", "inc" + (i.resolved_at ? "" : " open")); d.appendChild(el("b", "", i.title)); d.appendChild(el("small", "", i.resolved_at ? "Resolved " + ago(i.resolved_at) + " · started " + ago(i.started_at) : "Ongoing since " + ago(i.started_at))); inc.appendChild(d); });
    $("upd").textContent = (h.preview ? "Preview data — no API connected. " : "") + "Updated " + new Date(h.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · refreshes every 30 s";
  }
  function probeWeb() {
    var t0 = performance.now();
    return fetch("./", { method: "HEAD", cache: "no-store" }).then(function (r) { var ms = Math.round(performance.now() - t0); return r.ok ? { state: ms > 3000 ? "degraded" : "operational", latency_ms: ms, detail: ms > 3000 ? "slow to load" : "serving the site" } : { state: "down", detail: "HTTP " + r.status }; }).catch(function () { return { state: "down", detail: "not reachable from your network" }; });
  }
  function tick() {
    probeWeb().then(function (web) {
      if (!API) return render(sample(), web);
      get("/v1/health").then(function (h) { render(h, web); }).catch(function () {
        var h = { overall: "outage", components: [{ component: "api", state: "down", detail: "not reachable from your network" }], daily: [], incidents: [], generated_at: new Date().toISOString() };
        render(h, web);
      });
    });
  }
  function price() {
    var c = new AbortController(); setTimeout(function () { c.abort(); }, 6000);
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true", { signal: c.signal }).then(function (r) { return r.json(); }).then(function (j) {
      var p = j && j.solana; if (!p) return; $("sol-px").textContent = "$" + p.usd.toFixed(2); var ch = $("sol-chg"), v = p.usd_24h_change || 0; ch.textContent = (v >= 0 ? "+" : "") + v.toFixed(1) + "%"; ch.className = v >= 0 ? "up" : "down";
    }).catch(function () {});
  }
  tick(); price(); setInterval(tick, 30000); setInterval(price, 120000);
})();
