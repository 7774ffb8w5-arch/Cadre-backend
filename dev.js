/**
 * Live developer adapter. With TWENTY_CONFIG.API_BASE set, the demo's write flows (book a slot, file a report,
 * apply, challenge, holder vote, flag, ballot, disclosure) become wallet-signed requests to the API. Every
 * request is signed with `signMessage` in the connected wallet — the exact text the API verifies
 * (packages/shared/src/auth.ts → signedMessage). Nothing here spends funds: slot fees are plain SOL
 * transfers the developer makes from their own wallet with the memo the API hands out.
 *
 * Without API_BASE this file does nothing and the demo flows keep working on device state.
 */
(function () {
  const cfg = window.TWENTY_CONFIG || {}; const base = String(cfg.API_BASE || "").replace(/\/$/, "");
  if (!base || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) return;
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const S = (v, n) => (typeof safeStr === "function" ? safeStr(v, n) : String(v == null ? "" : v).slice(0, n || 64));
  const say = (m, k) => (typeof toast === "function" ? toast(m, k) : console.log(m));
  const H = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ── wallet + signing ─────────────────────────────────────────── */
  function b58(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b); let s = ""; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = "1" + s; else break; } return s; }
  function canonicalJson(v) { if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]"; return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}"; }
  async function sha256Hex(str) { const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
  const signedMessage = (action, wallet, nonce, issued, bodyHash) => `Cadre · ${action}\nwallet: ${wallet}\nnonce: ${nonce}\nissued: ${issued}\nbody: ${bodyHash}\n\nThis signature authorises one request. It never spends funds.`;
  const nonce = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return b58(a).slice(0, 32); };
  /* ── wallet picker: Phantom, Solflare, Backpack or any injected Solana wallet ───────────────── */
  const WALLETS = [
    { id: "phantom", name: "Phantom", find: () => (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom ? window.phantom.solana : window.solana && window.solana.isPhantom ? window.solana : null), open: (u) => "https://phantom.app/ul/browse/" + encodeURIComponent(u) + "?ref=" + encodeURIComponent(location.origin), get: "https://phantom.app/download" },
    { id: "solflare", name: "Solflare", find: () => (window.solflare && window.solflare.isSolflare ? window.solflare : null), open: (u) => "https://solflare.com/ul/v1/browse/" + encodeURIComponent(u) + "?ref=" + encodeURIComponent(location.origin), get: "https://solflare.com/download" },
    { id: "backpack", name: "Backpack", find: () => (window.backpack && window.backpack.isBackpack ? window.backpack : null), open: null, get: "https://backpack.app/downloads" },
  ];
  const installed = () => {
    const l = WALLETS.map((w) => ({ id: w.id, name: w.name, p: w.find() })).filter((x) => x.p);
    const g = window.solana; if (g && typeof g.connect === "function" && !l.some((x) => x.p === g)) l.push({ id: "browser", name: "Browser wallet", p: g });
    return l;
  };
  let cur = null, curName = "";
  const remembered = () => { try { return localStorage.getItem("twenty-wallet"); } catch (e) { return null; } };
  const remember = (id) => { try { if (id) localStorage.setItem("twenty-wallet", id); else localStorage.removeItem("twenty-wallet"); } catch (e) {} };
  function chooseWallet() {
    const list = installed(); const mem = remembered(); const pick = list.length === 1 ? list[0] : list.find((x) => x.id === mem);
    if (pick) return Promise.resolve(pick);
    return new Promise((resolve) => {
      if (typeof openModal !== "function") { say("Connect a Solana wallet (Phantom, Solflare, Backpack) first.", "warn"); return resolve(null); }
      const url = location.href.split("#")[0];
      const rows = list.length ? list.map((x) => `<button class="btn wl" type="button" data-wallet="${H(x.id)}">${H(x.name)}</button>`).join("")
        : WALLETS.map((w) => (w.open ? `<a class="btn wl" href="${H(w.open(url))}" rel="noopener">Open in ${H(w.name)}</a>` : `<a class="btn wl" href="${H(w.get)}" rel="noopener" target="_blank">Get ${H(w.name)}</a>`)).join("");
      openModal(`<h3>Connect a wallet</h3><p class="muted">${list.length ? "Pick the wallet to connect. Connecting shares your public address only — it never moves funds." : "No wallet found in this browser. On a phone, open the pad inside a wallet app; on a computer, install a wallet extension."}</p><div class="act wl-row">${rows}</div>`);
      const body = document.getElementById("modal-body"), modal = document.getElementById("modal"); let settled = false;
      const done = (v) => { if (settled) return; settled = true; mo.disconnect(); body.removeEventListener("click", onClick); resolve(v); };
      const onClick = (e) => { const b = e.target.closest("[data-wallet]"); if (!b) return; const w = list.find((x) => x.id === b.dataset.wallet); done(w || null); if (typeof closeModal === "function") closeModal(); };
      const mo = new MutationObserver(() => { if (modal.hidden) done(null); }); if (modal) mo.observe(modal, { attributes: true, attributeFilter: ["hidden"] });
      body.addEventListener("click", onClick);
    });
  }
  function bindEvents(p) {
    if (p.__twentyBound || typeof p.on !== "function") return; p.__twentyBound = true;
    try { p.on("accountChanged", () => setTimeout(syncWallet, 50)); p.on("disconnect", () => { if (cur === p) cur = null; setTimeout(syncWallet, 50); }); } catch (e) {}
  }
  async function connectWallet(o) {
    const w = (o && o.pick) || (o && o.silent ? installed().find((x) => x.id === remembered()) : await chooseWallet()); if (!w) return null;
    try {
      const r = await w.p.connect(o && o.silent ? { onlyIfTrusted: true } : undefined); const pk = r && r.publicKey ? r.publicKey : w.p.publicKey; if (!pk) return null;
      cur = w.p; curName = w.name; remember(w.id); bindEvents(w.p); return pk.toString();
    } catch (e) { if (!(o && o.silent)) say("Wallet connection was declined.", "warn"); return null; }
  }
  async function syncWallet() {
    const pk = cur && cur.publicKey ? cur.publicKey.toString() : null;
    if (typeof state !== "undefined" && (state.wallet || null) !== pk) { state.wallet = pk; try { saveState(); } catch (e) {} }
    if (typeof renderRole === "function") renderRole();
    return refreshMe();
  }
  async function provider() {
    if (!(cur && cur.publicKey)) { const pk = await connectWallet(); if (!pk) return null; await syncWallet(); }
    if (!cur || typeof cur.signMessage !== "function") { say("This wallet cannot sign messages. Use Phantom, Solflare or Backpack.", "warn"); return null; }
    return cur;
  }
  async function signed(action, method, path, body) {
    const p = await provider(); if (!p) throw new Error("no wallet");
    const wallet = p.publicKey.toString(); const n = nonce(), issued = new Date().toISOString();
    const bodyHash = await sha256Hex(canonicalJson(body == null ? {} : body));
    const sig = await p.signMessage(new TextEncoder().encode(signedMessage(action, wallet, n, issued, bodyHash)), "utf8");
    const signature = b58(sig.signature || sig);
    const r = await fetch(base + path, { method, credentials: "omit", headers: { "content-type": "application/json", "x-wallet": wallet, "x-signature": signature, "x-nonce": n, "x-issued": issued }, body: body == null ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(S(j.error || ("HTTP " + r.status), 200));
    return j;
  }
  const get = (path) => fetch(base + path, { credentials: "omit", headers: { accept: "application/json" } }).then((r) => r.json());
  const me = { wallet: null, info: null };
  async function refreshMe() {
    const w = cur && cur.publicKey ? cur.publicKey.toString() : null;
    if (!w || !B58.test(w)) {
      me.wallet = null; me.info = null; window.__twentyLive = null;
      if (typeof ROLES !== "undefined" && typeof state !== "undefined") { delete ROLES.live; if (state.role === "live") { state.role = "visitor"; try { saveState(); } catch (e) {} } try { renderAll(); } catch (e) {} }
      const tag = document.getElementById("wallet-tag"); if (tag) tag.hidden = true; return me;
    }
    me.wallet = w; me.info = await get("/v1/wallets/" + w).catch(() => null);
    /* no bond, no payouts: a ban pays nothing, so there are no claims to look up */
    window.__twentyLive = { info: me.info, wallet: me.wallet };
    /* the page's role model follows the live wallet: a seat holder, a bench developer or a committee member gets a
       live role, and every renderer (calendar, drawers, challenge buttons, report cards) keys off it as in the demo */
    if (typeof ROLES !== "undefined" && typeof state !== "undefined" && typeof renderAll === "function") {
      const i = me.info || {}; const pad = (n) => String(n).padStart(2, "0");
      const live = i.seat ? { label: `Seat ${pad(i.seat.seat)} · ${S(i.seat.handle, 32)} · your wallet`, kind: "seat", seat: i.seat.seat }
        : i.application && i.application.stage === "bench" ? { label: `Bench · ${S(i.application.handle, 32)} · your wallet`, kind: "bench", name: S(i.application.handle, 32) }
        : i.committee ? { label: `Committee · ${S(i.committee, 32)} · your wallet`, kind: "committee", name: S(i.committee, 32) } : null;
      if (live) { ROLES.live = live; if (state.role !== "live") { state.role = "live"; saveState(); } renderAll(); }
      else if (state.role === "live") { delete ROLES.live; state.role = "visitor"; saveState(); renderAll(); }
      const tag = document.getElementById("wallet-tag"); if (tag && me.wallet) { tag.hidden = false; tag.textContent = `${me.wallet.slice(0, 4)}…${me.wallet.slice(-4)} · ${live ? live.label.replace(" · your wallet", "") : "not on roster or bench"}`; }
    }
    return me;
  }
  /* a returning visitor is reconnected silently when the wallet already trusts the site */
  async function autoConnect() { if (remembered()) await connectWallet({ silent: true }); await syncWallet(); }
  window.addEventListener("load", () => { setTimeout(autoConnect, 400); setTimeout(() => { if (!cur && remembered()) autoConnect(); }, 2500); });

  /* the connect button: pick a wallet, learn the role, land in the console */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("#connect, #connect-m"); if (!b) return; stop(e);
    if (cur && cur.publicKey) { try { await cur.disconnect(); } catch (x) {} cur = null; remember(null); await syncWallet(); say("Wallet disconnected."); return; }
    const pk = await connectWallet(); if (!pk) return; await syncWallet();
    const live = typeof ROLES !== "undefined" && ROLES.live;
    say(live ? `Connected · ${live.label.replace(" · your wallet", "")}` : "Connected. This address holds no seat and is not on the bench.", "good");
    if (live && (!location.hash || location.hash === "#" || location.hash === "#top")) location.hash = "#console";
  }, true);

  /* a launch the pad registered from chain data for this seat: prompt for the disclosure until it is complete */
  function disclosurePrompt() {
    const i = me.info || {}; const seat = i.seat && i.seat.seat; const old = document.getElementById("disclose-bar"); if (old) old.remove();
    if (!seat || typeof LAUNCHES === "undefined") return;
    const open = LAUNCHES.filter((l) => l.seat === seat && l.mint && /undisclosed/i.test(String(l.lp || l.liquidity || "")) && l.status !== "banned");
    if (!open.length) return;
    const bar = document.createElement("div"); bar.id = "disclose-bar"; bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:60;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border:1px solid rgba(154,107,255,.55);border-radius:10px;background:color-mix(in srgb,var(--bg-2,#15171a) 92%,transparent);backdrop-filter:blur(10px);font-size:14px;box-shadow:0 24px 60px -30px rgba(0,0,0,.8)";
    bar.innerHTML = `<span><b>$${H(open[0].tk)}</b> was registered from chain data for Seat ${String(seat).padStart(2, "0")}. Complete the disclosure within 24 h of launch — dev allocation, liquidity, insider wallets.</span><button class="btn pri sm" type="button" data-disclose="${H(open[0].mint)}">Complete disclosure</button>`;
    document.body.appendChild(bar);
  }
  const _refresh = refreshMe;
  refreshMe = async function () { const r = await _refresh(); try { disclosurePrompt(); } catch (e) {} return r; };
  window.__twentyMe = refreshMe;
  window.__twentyMe = refreshMe;

  /* ── one-tap payment: slot fees are plain SOL transfers with a memo ────────────────────────
     The API prepares the unsigned transfer; this page checks it byte by byte before the wallet sees it,
     the wallet signs and sends, and /v1/pay/status shows the pad confirming it. A QR / Solana Pay link
     covers phone wallets, and the plain details stay one click away. */
  const SYS = "1".repeat(32), MEMO_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", MEMO_RE = /^(SLOT|CHAL)-[0-9A-F]{8}$/, SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
  const pinned = B58.test(String(cfg.TREASURY || "")) ? String(cfg.TREASURY) : null;
  function readShort(b, o) { let v = 0, sh = 0, n = 0; for (;;) { const x = b[o + n++]; if (x === undefined || n > 3) throw new Error("bad transaction"); v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return [v, n]; }
  function messageOf(bytes) { const [ns, n] = readShort(bytes, 0); return bytes.slice(n + ns * 64); }
  /** The prepared transaction must be exactly [system transfer payer → treasury of the right amount, memo]. */
  function checkTransfer(bytes, want) {
    const fail = (m) => { throw new Error("The prepared transfer does not match what you are paying (" + m + ") — nothing was sent."); };
    const [ns, n0] = readShort(bytes, 0); let o = n0 + ns * 64; if (bytes[o] & 0x80) fail("version"); if (bytes[o] !== 1) fail("signers"); o += 3;
    const [nk, n1] = readShort(bytes, o); o += n1; const keys = []; for (let i = 0; i < nk; i++) keys.push(b58(bytes.slice(o + i * 32, o + i * 32 + 32))); o += nk * 32 + 32;
    const [ni, n2] = readShort(bytes, o); o += n2; if (ni !== 2) fail("instructions");
    const ix = []; for (let i = 0; i < ni; i++) { const prog = keys[bytes[o++]]; const [na, n3] = readShort(bytes, o); o += n3; const acc = [...bytes.slice(o, o + na)].map((k) => keys[k]); o += na; const [nd, n4] = readShort(bytes, o); o += n4; const data = bytes.slice(o, o + nd); o += nd; ix.push({ prog, acc, data }); }
    if (o !== bytes.length) fail("length"); if (keys[0] !== want.payer) fail("payer");
    const t = ix[0]; if (t.prog !== SYS || t.data.length !== 12 || t.acc.length !== 2) fail("transfer");
    const dv = new DataView(t.data.buffer, t.data.byteOffset, 12); if (dv.getUint32(0, true) !== 2) fail("transfer type");
    if (t.acc[0] !== want.payer || t.acc[1] !== want.to) fail("destination"); if (dv.getBigUint64(4, true) !== BigInt(want.lamports)) fail("amount");
    const m = ix[1]; if (m.prog !== MEMO_ID || new TextDecoder().decode(m.data) !== want.memo) fail("memo");
    return true;
  }
  const isReject = (e) => e && (e.code === 4001 || /reject|denied|declin|cancel|closed by user/i.test(String(e.message || e)));
  const sigOf = (r) => { const x = typeof r === "string" ? r : r && r.signature; if (!x) throw new Error("the wallet did not return a signature"); return String(x); };
  async function sendTx(p, bytes) {
    /* wallets accept a web3.js Transaction; they only ever call serialize() on it, so a thin stand-in is enough */
    const shim = { signatures: [], serialize: () => bytes, serializeMessage: () => messageOf(bytes) }; let last;
    if (typeof p.signAndSendTransaction === "function") { try { return sigOf(await p.signAndSendTransaction(shim)); } catch (e) { if (isReject(e)) throw e; last = e; } }
    if (typeof p.request === "function") { try { return sigOf(await p.request({ method: "signAndSendTransaction", params: { message: b58(bytes) } })); } catch (e) { if (isReject(e)) throw e; last = e; } }
    throw last || new Error("this wallet cannot send a prepared transfer");
  }
  const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(S(j.error || "HTTP " + r.status, 200)); return j; };
  window.__twentyPay = { checkTransfer, sendTx, messageOf };

  (function css() { const el = document.createElement("style"); el.textContent = `.wl-row{flex-wrap:wrap}.wl-row .btn{flex:1 1 140px;text-align:center}.pay-sum{font-size:18px;margin:6px 0 10px}.pay-steps{display:flex;gap:6px;list-style:none;padding:0;margin:0 0 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase}.pay-steps li{flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,.14));color:var(--muted,#8a8f98);text-align:center}.pay-steps li.on{color:var(--text,#e8e6e1);border-color:var(--gold,#9A6BFF)}.pay-steps li.done{color:#7bd88f;border-color:#7bd88f}.pay-alt{margin-top:12px;border-top:1px solid var(--line,rgba(255,255,255,.1));padding-top:10px}.pay-alt summary{cursor:pointer;color:var(--muted,#8a8f98)}.pay-qr{display:flex;justify-content:center;margin:10px 0}.pay-qr svg{border-radius:10px;max-width:100%;height:auto}`; document.head.appendChild(el); })();

  function payModal(title, r, onDone) {
    const to = String(r.pay_to || ""), amt = Number(r.amount_sol);
    if (typeof openModal !== "function" || !MEMO_RE.test(String(r.memo || "")) || !B58.test(to) || !(amt > 0)) { say(`${title}: send ${r.amount_sol} SOL to ${r.pay_to} with memo ${r.memo}`, "good"); return; }
    const url = `solana:${to}?amount=${amt}&label=The%20Twenty&memo=${r.memo}`; const list = installed(); const wl = (cur && curName) || (list.length === 1 ? list[0].name : "");
    const until = r.expires_at ? new Date(r.expires_at) : null;
    openModal(`<h3>${H(title)}</h3>
      <p class="pay-sum"><b>${H(amt)} SOL</b> <span class="muted">→ Cadre treasury${until && !isNaN(until) ? ` · pay by ${H(until.toUTCString().slice(5, 22))} UTC` : ""}</span></p>
      <ol class="pay-steps"><li class="on" data-s="pay">Pay</li><li data-s="sent">Sent</li><li data-s="ok">Confirmed</li></ol>
      <p class="muted" id="pay-state">One tap. Your wallet shows the transfer and the memo before you approve.</p>
      <div class="act"><button class="btn pri" type="button" id="pay-wallet">${wl ? `Pay ${H(amt)} SOL with ${H(wl)}` : `Pay ${H(amt)} SOL with a wallet`}</button><button class="btn" type="button" data-close>Close</button></div>
      <details class="pay-alt" id="pay-alt"><summary>Pay from a phone or another wallet</summary>
        <div class="pay-qr">${window.__twentyQR ? window.__twentyQR.svg(url, { size: 188 }) : ""}</div>
        <p class="muted sm">Scan with a Solana Pay wallet, or <a href="${H(url)}">open it in your wallet app</a>. Amount and memo are filled in.</p>
        <dl class="kv"><dt>To</dt><dd class="mono" style="word-break:break-all">${H(to)} <button class="lnk" type="button" data-copy-pay="${H(to)}">copy</button></dd><dt>Amount</dt><dd class="mono">${H(amt)} SOL</dd><dt>Memo</dt><dd class="mono"><b>${H(r.memo)}</b> <button class="lnk" type="button" data-copy-pay="${H(r.memo)}">copy</button></dd></dl>
        <p class="muted sm">The memo must be exact — the pad matches the transfer by it.</p></details>`);
    const state = document.getElementById("pay-state"), btn = document.getElementById("pay-wallet"); let finished = false;
    const alive = () => document.body.contains(state);
    const msg = (t) => { if (alive()) state.textContent = t; };
    const step = (k) => { if (!alive()) return; const order = ["pay", "sent", "ok"]; document.querySelectorAll(".pay-steps li").forEach((li) => { const i = order.indexOf(li.dataset.s), c = order.indexOf(k); li.className = i < c || (k === "ok" && i === c) ? "done" : i === c ? "on" : ""; }); };
    const poll = async () => {
      if (finished || !alive()) return;
      try {
        const st = await get("/v1/pay/status/" + r.memo);
        if (st.state === "confirmed") { finished = true; step("ok"); if (window.buzz) buzz([20,50,30,50,60]); msg("Confirmed on chain. " + "Your slot is booked."); if (btn) btn.disabled = true; say(title + " confirmed.", "good"); try { if (typeof window.__twentyReload === "function") window.__twentyReload(); await refreshMe(); } catch (e) {} setTimeout(() => { if (alive() && typeof closeModal === "function") closeModal(); }, 2200); return; }
        if (st.state === "expired") { finished = true; msg("This booking expired before it was paid. Book the slot again."); return; }
      } catch (e) {}
      setTimeout(poll, 3500);
    };
    setTimeout(poll, 3500);
    btn.addEventListener("click", async () => {
      btn.disabled = true; msg("Opening your wallet…");
      try {
        const p = await provider(); if (!p) { btn.disabled = false; msg("No wallet connected — use the QR code or the details below."); document.getElementById("pay-alt").open = true; return; }
        const payer = p.publicKey.toString(); const prep = await post("/v1/pay/prepare", { memo: r.memo, payer });
        const bytes = Uint8Array.from(atob(prep.transaction), (c) => c.charCodeAt(0));
        checkTransfer(bytes, { payer, to: pinned || to, lamports: BigInt(Math.round(amt * 1e9)), memo: r.memo });
        msg("Approve the transfer in your wallet…"); const sig = await sendTx(p, bytes);
        step("sent"); btn.textContent = "Sent";
        msg(SIG_RE.test(sig) ? "Sent. The pad confirms it within about a minute — this card updates itself." : "Sent. Waiting for the pad to see it…");
        if (SIG_RE.test(sig) && alive()) { const a = document.createElement("a"); a.href = `https://solscan.io/tx/${sig}${cfg.CLUSTER === "devnet" ? "?cluster=devnet" : ""}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = " View transaction"; state.appendChild(a); }
        poll();
      } catch (err) {
        btn.disabled = false; msg(isReject(err) ? "Cancelled — nothing was sent." : S(err && err.message, 180) + " You can still pay with the QR code or the details below.");
        if (!isReject(err)) { const d = document.getElementById("pay-alt"); if (d) d.open = true; }
      }
    });
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-copy-pay], [data-copy-memo]"); if (b) { const v = b.dataset.copyPay || b.dataset.copyMemo; navigator.clipboard && navigator.clipboard.writeText(v).then(() => say("Copied.", "good")); } });

  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const fail = (err) => say(S(err && err.message ? err.message : err, 200), "warn");

  /* ── pay a pending booking from the console ──────────────────── */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pay-booking]"); if (!b) return; stop(e);
    const id = b.dataset.payBooking; const bk = ((me.info && me.info.bookings) || []).find((x) => x.id === id); if (!bk) return say("Booking not found — refresh.", "warn");
    const pad = await get("/v1/pad").catch(() => null);
    payModal("Slot fee", { amount_sol: pad && pad.slot_fee_sol || 3, pay_to: (pad && pad.treasury_wallet) || (me.info && me.info.pay_to) || "", memo: bk.memo, expires_at: bk.expires_at }, async () => { await refreshMe(); return ((me.info && me.info.bookings) || []).some((x) => x.id === id && x.status === "confirmed"); });
  }, true);

  /* ── §1 book a slot ───────────────────────────────────────────── */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-book]"); if (!b) return; stop(e);
    const ts = +b.dataset.book; if (!Number.isFinite(ts)) return;
    try {
      const r = await signed("book slot", "POST", "/v1/slots/book", { slot_at: new Date(ts).toISOString() });
      if (me.info) me.info.pay_to = r.pay_to; setTimeout(refreshMe, 1500);
      if (r.status === "confirmed") { say("Slot booked.", "good"); return; }
      payModal("Slot fee", r, async () => { const w = await get("/v1/wallets/" + me.wallet); return (w.bookings || []).some((x) => x.id === r.booking_id && x.status === "confirmed"); });
    } catch (err) { fail(err); }
  }, true);

  /* ── §6 reports ───────────────────────────────────────────────── */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-report]"); if (!b) return; stop(e);
    const tk = b.dataset.report, which = +b.dataset.which; const l = (typeof LAUNCHES !== "undefined" ? LAUNCHES : []).find((x) => x.tk === tk); if (!l || !l.mint) return say("Launch not found in the live feed.", "warn");
    openModal(`<h3>File the day-${which} report · $${H(tk)}</h3><p>Link the public report (X post, Telegram pin, or a page). It goes on the record with its timestamp.</p>
      <label class="fld"><span>Report URL</span><input type="url" id="rep-url" placeholder="https://x.com/…" required></label>
      <div class="act"><button class="btn" type="button" data-close>Cancel</button><button class="btn pri" type="button" id="rep-go">File on the record</button></div>`);
    document.getElementById("rep-go").addEventListener("click", async () => {
      const url = document.getElementById("rep-url").value.trim(); if (!/^https:\/\/\S{4,300}$/.test(url)) return say("A https:// link is required.", "warn");
      try { const r = await signed("file report", "POST", `/v1/launches/${l.mint}/reports/${which}`, { url }); closeModal(); say(`Day-${which} report filed${r.state === "late" ? " — late, a warning is on the record" : ""}.`, r.state === "late" ? "warn" : "good"); } catch (err) { fail(err); }
    });
  }, true);

  /* ── §6 disclosure (auto-registered launches) ──────────────────── */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-disclose]"); if (!b) return; stop(e);
    const mint = b.dataset.disclose; if (!B58.test(mint)) return;
    openModal(`<h3>Complete the disclosure</h3>
      <label class="fld"><span>Dev allocation (%)</span><input type="number" id="dis-dev" min="0" max="5" step="0.1" value="0"></label>
      <label class="fld"><span>Liquidity</span><input type="text" id="dis-lp" placeholder="burned · locked <locker> until <date> · bonding curve"></label>
      <label class="fld"><span>Insider wallets <small>· label, address, % — one per line</small></span><textarea id="dis-w" rows="4" placeholder="team, 9xQe…, 2.5"></textarea></label>
      <div class="act"><button class="btn" type="button" data-close>Cancel</button><button class="btn pri" type="button" id="dis-go">Publish</button></div>`);
    document.getElementById("dis-go").addEventListener("click", async () => {
      const wallets = document.getElementById("dis-w").value.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((line) => { const [label, address, pct] = line.split(",").map((x) => x.trim()); return { label: S(label, 24), address, pct: Number(pct) }; });
      const body = { dev_allocation_pct: Number(document.getElementById("dis-dev").value), liquidity: S(document.getElementById("dis-lp").value, 80), wallets };
      try { await signed("register launch", "PATCH", `/v1/launches/${mint}`, body); closeModal(); say("Disclosure published.", "good"); } catch (err) { fail(err); }
    });
  }, true);

  /* ── §2 apply ─────────────────────────────────────────────────── */
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("#apply-form"); if (!f) return; stop(e);
    const handle = (document.getElementById("f-handle") || {}).value || "", wallet = (document.getElementById("f-wallet") || {}).value || "";
    const mints = ((document.getElementById("f-launches") || {}).value || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const contact = ((document.getElementById("f-contact") || document.getElementById("f-handle") || {}).value || "").trim();
    if (mints.length < 3 || !mints.every((m) => B58.test(m))) return say("At least three mint addresses, one per line.", "warn");
    try {
      const p = await provider(); if (!p) return;
      if (wallet && p.publicKey.toString() !== wallet.trim()) return say("Connect the deployer wallet you entered — the application is signed with it.", "warn");
      const r = await signed("apply", "POST", "/v1/apply", { handle: handle.trim(), mints, contact });
      const ref = document.getElementById("apply-ref"); if (ref) ref.textContent = r.ref;
      f.hidden = true; const steps = document.getElementById("wiz-steps"); if (steps) steps.hidden = true; const ok = document.getElementById("apply-ok"); if (ok) ok.hidden = false;
      say(`Application ${r.ref} received · pre-check ${r.precheck.score}.`, "good");
    } catch (err) { fail(err); }
  }, true);

  /* ── §5 challenges and holder signal ──────────────────────────── */
  document.addEventListener("click", async (e) => {
    const sg = e.target.closest("[data-signal]"), ch = e.target.closest("[data-challenge]"); if (!sg && !ch) return; stop(e);
    const seat = +(sg ? sg.dataset.signal : ch.dataset.challenge); if (!(seat >= 1 && seat <= 20)) return;
    try {
      let evidence; if (!sg) { evidence = (window.prompt("Public evidence for this challenge (a sentence and a link). Filing is free.") || "").trim(); if (evidence.length < 20) return say("A filed challenge needs public evidence.", "warn"); }
      const r = await signed("challenge", "POST", "/v1/challenges", sg ? { seat, kind: "signal" } : { seat, kind: "filed", evidence });
      say(sg ? `Challenge signaled against Seat ${String(seat).padStart(2, "0")}.` : `Challenge filed against Seat ${String(seat).padStart(2, "0")} — free, public, decided within 24 h.`, "good");
    } catch (err) { fail(err); }
  }, true);
  document.addEventListener("click", async (e) => {
    const vb = e.target.closest("[data-vote]"); if (!vb) return; stop(e);
    const seat = +vb.dataset.seat, vote = vb.dataset.vote === "keep" ? "keep" : "replace";
    try {
      const list = await get("/v1/challenges?seat=" + seat); const open = list.find((x) => x.status === "filed"); if (!open) return say("No filed challenge on this seat right now.", "warn");
      const r = await signed("holder vote", "POST", `/v1/challenges/${open.id}/holder-vote`, { vote }); say(`Holder signal recorded: ${vote} · weight ${r.weight_pct}%.`, "good");
    } catch (err) { fail(err); }
  }, true);

  /* ── §11 flag an applicant in public review ───────────────────── */
  document.addEventListener("click", async (e) => {
    const fb = e.target.closest("[data-flag]"); if (!fb) return; stop(e);
    const handle = fb.dataset.flag;
    try {
      const apps = await get("/v1/applications?stage=public_review"); const a = apps.find((x) => x.handle === handle); if (!a) return say("This application is not in public review.", "warn");
      openModal(`<h3>Flag ${H(handle)}</h3><p>On-chain evidence only: transaction signatures or explorer links, one per line. An upheld flag pays 2 SOL; three discarded flags lock the filing wallet.</p>
        <label class="fld"><span>What you found</span><textarea id="fl-claim" rows="2" maxlength="400"></textarea></label>
        <label class="fld"><span>Evidence</span><textarea id="fl-ev" rows="3"></textarea></label>
        <div class="act"><button class="btn" type="button" data-close>Cancel</button><button class="btn pri warn" type="button" id="fl-go">File flag</button></div>`);
      document.getElementById("fl-go").addEventListener("click", async () => {
        const claim = document.getElementById("fl-claim").value.trim(), evidence = document.getElementById("fl-ev").value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
        if (claim.length < 10 || !evidence.length) return say("A claim and at least one piece of evidence.", "warn");
        try { await signed("flag application", "POST", `/v1/applications/${a.ref}/flags`, { claim, evidence }); closeModal(); say("Flag filed. The committee rules on it before the window closes.", "good"); } catch (err) { fail(err); }
      });
    } catch (err) { fail(err); }
  }, true);

  /* ── §12 ballot ───────────────────────────────────────────────── */
  document.addEventListener("click", async (e) => {
    const v = e.target.closest("[data-vote-wc]"); if (!v) return; stop(e);
    const candidate = v.dataset.voteWc;
    try {
      const p = await provider(); if (!p) return; const wallet = p.publicKey.toString();
      const el = await get("/v1/election/eligibility/" + wallet); if (!el.eligible) return say("This wallet held no eligible position at the day-20 snapshot.", "warn");
      const issued = new Date().toISOString(); const msg = el.message_template.replace("<candidate>", candidate).replace("<nonce>", el.nonce).replace("<issued_at>", issued);
      const sig = await p.signMessage(new TextEncoder().encode(msg), "utf8");
      const r = await fetch(base + "/v1/election/ballot", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, candidate, nonce: el.nonce, issued_at: issued, signature: b58(sig.signature || sig) }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status);
      say(`Ballot ${j.moved ? "moved to" : "cast for"} ${candidate} · weight ${j.weight_pct}%.`, "good");
    } catch (err) { fail(err); }
  }, true);

  /* refresh the wallet's standing after connects */
  document.addEventListener("click", (e) => { if (e.target.closest("[data-connect], #connect, .connect")) setTimeout(refreshMe, 1500); });
  refreshMe();
})();
