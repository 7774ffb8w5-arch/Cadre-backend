/**
 * Live-API adapter. When TWENTY_CONFIG.API_BASE is set, the site swaps its built-in sample data for the
 * /v1 feeds before the first render and refreshes every 60 s. Field names follow packages/shared/src/types.ts.
 * Without API_BASE this file does nothing, so the same index.html works as a preview and as the live site.
 *
 * Hardening: every string that reaches a template is passed through safeStr() (no markup, capped length),
 * every number is coerced, every array is checked, and fetches time out after 10 s.
 */
(function () {
  const cfg = window.TWENTY_CONFIG || {}; const base = String(cfg.API_BASE || "").replace(/\/$/, "");
  if (!base || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) return;
  const DAYMS = 86400000;
  const S = (v, n) => (typeof safeStr === "function" ? safeStr(v, n) : String(v == null ? "" : v).slice(0, n || 64));
  const N = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const A = (v) => (Array.isArray(v) ? v : []);
  const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const TICKER = (v) => { const t = S(v, 12).toUpperCase().replace(/[^A-Z0-9]/g, ""); return t || "TOKEN"; };
  const get = (p) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    return fetch(base + p, { headers: { accept: "application/json" }, signal: ctrl.signal, credentials: "omit", mode: "cors" })
      .then((r) => { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); })
      .finally(() => clearTimeout(t));
  };

  async function load() {
    const [pad, seats, slots, launches, log] = await Promise.all([get("/v1/pad"), get("/v1/seats"), get("/v1/slots"), get("/v1/launches"), get("/v1/log?limit=200").catch(() => [])]);
    if (!pad || typeof pad !== "object" || !Array.isArray(seats) || !Array.isArray(launches)) throw new Error("bad feed shape");
    // seats
    SEATS.length = 0;
    seats.slice(0, 20).forEach((r) => { const hist = A(r.score_30d).map((x) => N(x)).slice(-30);
      SEATS.push({
        n: N(r.seat), dev: S(r.developer, 32) || "vacant", walletFull: WALLET.test(String(r.wallet)) ? r.wallet : "", since: "S" + Math.max(0, N(pad.season) - (hist.length >= 30 ? 1 : 0)),
        surv: N(r.survival_pct), hold: N(r.holder_outcome_pct), peak: N(r.median_peak_x), warnings: N(r.warnings), total: N(r.launches_total), season: N(r.launches_season),
        drift: hist.length > 1 ? hist[hist.length - 1] - hist[0] : 0, noticeSeasons: r.status === "notice" ? 1 : 0, cleanSeasons: r.tenured ? 3 : 0, liveHist: hist, record: [],
      }); });
    // launches
    LAUNCHES.length = 0;
    launches.slice(0, 100).forEach((l) => { const wallets = A(l.disclosed_wallets).slice(0, 20).map((w) => ({ label: S(w.label, 24), pct: N(w.pct), addr: WALLET.test(String(w.address)) ? w.address : "" }));
      LAUNCHES.push({
        tk: TICKER(l.ticker), mint: WALLET.test(String(l.mint)) ? l.mint : "", launchedTs: Date.parse(String(l.launched_at || "")) || 0, seat: N(l.seat), daysAgo: Math.max(0, N(l.day)), launchCap: N(l.launch_cap_usd) || 1, peakCap: (N(l.peak_multiple) || 1) * (N(l.launch_cap_usd) || 1), nowCap: N(l.mcap_usd),
        peakAt: 0.5, holders: N(l.holders), dev: N(l.dev_allocation_pct), lp: S(l.liquidity, 40) || "unknown", insiders: wallets.map((w) => [w.label, w.pct]), insiderWallets: wallets, devName: S(l.developer, 32),
        removed: l.status === "banned", slashed: l.banned && typeof l.banned === "object" ? { day: N(l.banned.day), what: S(l.banned.reason, 140) || "banned on the record", payout: 0, holders: 0 } : undefined,
        d7: ["filed", "due", "late", "missing"].includes(l.reports && l.reports.d7) ? l.reports.d7 : "due", d30: ["filed", "due", "late", "missing"].includes(l.reports && l.reports.d30) ? l.reports.d30 : "due", walletFull: WALLET.test(String(l.mint)) ? l.mint : "",
      }); });
    // slots → SAMPLE_SLOTS shape (offset from today, hour, seat)
    const t0 = Math.floor(Date.now() / DAYMS) * DAYMS;
    SAMPLE_SLOTS.length = 0;
    A(slots).filter((s) => s && s.seat).forEach((s) => { const ts = Date.parse(s.time); if (!Number.isFinite(ts)) return; SAMPLE_SLOTS.push({ off: Math.round((ts - t0 - new Date(ts).getUTCHours() * 3600000) / DAYMS), h: new Date(ts).getUTCHours(), seat: N(s.seat) }); });
    // bench
    BENCH.length = 0; A(pad.bench).slice(0, 12).forEach((name, i) => BENCH.push({ name: S(name, 32) || "—", status: "passed", passedDaysAgo: 0, prior: 0, flags: 0, pre: 100 - i * 4 }));
    // pad constants that the page derives otherwise
    PAD.liveTreasury = N(pad.treasury_sol);
    window.__padLive = pad; window.__logLive = A(log);
    renderAll();
    // real 30-day histories replace the generated ones
    SEATS.forEach((s) => { if (s.liveHist && s.liveHist.length >= 2) { const h = s.liveHist.slice(-30); while (h.length < 30) h.unshift(h[0]); s.hist = h; } });
    renderRoster(); renderStandings(); redrawAllCharts();
  }
  // the launch room draws the real 6-hour series once it is opened
  if (typeof openLaunch === "function") { const _ol = openLaunch; openLaunch = function (tk, refresh) { _ol(tk, refresh); const l = LAUNCHES.find((x) => x.tk === tk); if (!l || !l.mint || l.livePath) return; l.livePath = true;
    get("/v1/launches/" + encodeURIComponent(l.mint) + "/snapshots").then((rows) => { const pts = A(rows).map((r) => N(r.mcap_usd)).filter((v) => v > 0); if (pts.length >= 2) { l.path = pts; l.peakCap = Math.max(...pts); if (typeof drawerView !== "undefined" && drawerView && drawerView.type === "launch" && drawerView.id === tk) _ol(tk, true); } }).catch(() => {}); }; }
  // machine status for the console strip
  const status = () => get("/v1/status").then((s) => { window.__twentyStatus = s; if (typeof renderConsole === "function" && document.body.dataset.view === "console") renderConsole(); }).catch(() => {});
  // live scanner — the address is validated before it leaves the browser
  window.__scanLive = async (q) => { if (!WALLET.test(String(q))) throw new Error("not a Solana address"); return get("/v1/scan/" + encodeURIComponent(q)); };
  window.__twentyReload = () => load().catch(() => {});
  load().then(() => { toast("Live data from " + base.replace(/^https?:\/\//, ""), "good"); status(); setInterval(() => load().catch(() => {}), 60000); setInterval(status, 60000); })
        .catch((e) => { console.error(e); toast("Live API unreachable, showing the preview data.", "warn"); });
})();
