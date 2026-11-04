/**
 * `npm run demo` — the whole pad on one machine, no Postgres, no Helius key:
 *   an in-process Postgres (PGlite) with the production schema, twenty seated developers with a record,
 *   a committee, a bench, upcoming bookings, a scripted chain and market, the scheduler ticking every 30 s,
 *   and the API on http://localhost:8080 with CORS open.
 *
 * Point the site at it (web/config.js → API_BASE = "http://localhost:8080") and the demo data is replaced by
 * these feeds; connect a wallet and set DEMO_WALLET=<its address> to hold seat 01 and book, launch and file
 * reports against the real rules. DEMO_SPEED=60 makes the clock run 60× (a day every 24 min) so the lifecycle
 * can be watched; the default is real time.
 */
import { freshDb, FakeChain, wallet, slotAt } from "./testkit.js";
import { makeCtx } from "./runtime.js";
import { disabledOracle } from "./oracle.js";
import { build } from "./server.js";
import { tick, JOBS, recoverRuns } from "./jobs/runner.js";
import { runScoreCron } from "./jobs/score-cron.js";
import { PAD, seasonInfo } from "@twenty/shared";
import { lamports } from "./ctx.js";
import { generateVapidKeys, configureVapid, type PushSender } from "@twenty/shared";
import { dispatchOnce } from "@twenty/bot";

const DEVS = ["Ashgrove", "Verdigris", "Kestrel Labs", "Halcyon", "Ironweed", "Meridian", "Sable", "Fennimore", "Quillon", "Oriel", "Tamsin Works", "Basalt", "Lumen", "Corvid", "Palisade", "Marrow", "Tesseract", "Hollowell", "Vantage", "Nyx Lab"];
const BENCH = ["Cairnwright", "Umbra Forge", "Pell & Dray", "Saltmarsh"];
const COMMITTEE = ["Greywater", "Alder", "Mercer", "Thistle", "Rook"];
const TICKERS = ["ORBIT", "KESTREL", "HALO", "IRON", "MERID", "SABLE", "FENN", "QUILL", "ORIEL", "TAMSIN", "BASALT", "LUMEN", "CORVID", "PALIS", "MARROW", "TESS", "HOLLOW", "VANT", "NYX", "ASH"];

const PORT = Number(process.env.PORT ?? 8080);
const SPEED = Math.max(1, Number(process.env.DEMO_SPEED ?? 1));
const DAY = 86_400_000;
process.env.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE ?? "0";
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "*";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";
process.env.KEY_PEPPER = process.env.KEY_PEPPER ?? "demo-pepper";
process.env.HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? "demo-hook";
/* web push: ephemeral VAPID keys per run unless real ones are set; DEMO_PUSH=real sends to the browser's push service, otherwise sends are logged */
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) { const k = generateVapidKeys(); process.env.VAPID_PUBLIC_KEY = k.publicKey; process.env.VAPID_PRIVATE_KEY = k.privateKey; }
configureVapid(process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!, process.env.VAPID_SUBJECT || "mailto:demo@cadre-us.org");
process.env.PUSH_ALLOW_ANY_ENDPOINT = process.env.PUSH_ALLOW_ANY_ENDPOINT ?? "1";
const pushLog: { at: string; endpoint: string; title: string; body: string }[] = [];
const demoSend: PushSender = async (sub, msg) => { pushLog.unshift({ at: new Date().toISOString(), endpoint: sub.endpoint.slice(0, 60), title: msg.title, body: msg.body }); if (pushLog.length > 50) pushLog.length = 50; console.log(`[push] → ${sub.endpoint.slice(0, 40)}… · ${msg.title}`); return { ok: true, gone: false, status: 201 }; };

const t0 = Date.now();
const clock = { get now() { return t0 + (Date.now() - t0) * SPEED; }, set now(_v: number) {} };
const anchor = Date.parse(process.env.SEASON_ANCHOR_UTC ?? "2026-10-12T00:00:00Z");
const rnd = (seed: number) => { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };

async function seed() {
  const db = await freshDb({ now: clock.now });
  const chain = new FakeChain();
  const treasury = wallet();
  const ctx = makeCtx({ pool: db, helius: chain.helius(), fetch: chain.fetch(), now: () => clock.now, anchorMs: anchor, oracle: disabledOracle, treasury: treasury.address, sendPush: process.env.DEMO_PUSH === "real" ? undefined : demoSend, log: { info() {}, warn(o, m) { console.warn(m, o); }, error(o, m) { console.error(m, o); } } });
  const r = rnd(20);
  const devs: { id: string; wallet: ReturnType<typeof wallet>; handle: string }[] = [];
  for (let i = 1; i <= 20; i++) {
    const w = wallet(); const address = i === 1 && process.env.DEMO_WALLET ? process.env.DEMO_WALLET : w.address;
    const { rows: [d] } = await db.query(`insert into developers(handle, deployer_wallet, contact, identity_verified_at) values ($1,$2,$3,now()) returning id`, [DEVS[i - 1], address, `${DEVS[i - 1].toLowerCase().replace(/\W+/g, "")}@example.com`]);
    const clean = i <= 6 ? 3 : i <= 14 ? 1 : 0;
    await db.query(`update seats set developer_id=$2, status='seated', since_season=$3, clean_seasons=$4 where seat=$1`, [i, d.id, Math.max(1, 4 - clean), clean]);
    devs.push({ id: d.id, wallet: w, handle: DEVS[i - 1] });
  }
  for (const [i, name] of COMMITTEE.entries()) await db.query(`insert into committee_members(name, wallet, since_season, term_end_season, focus) values ($1,$2,1,3,$3)`, [name, wallet().address, ["on-chain forensics", "market structure", "community", "legal", "security"][i]]);
  for (const [i, name] of BENCH.entries()) {
    const w = wallet();
    const { rows: [d] } = await db.query(`insert into developers(handle, deployer_wallet, contact) values ($1,$2,$3) returning id`, [name, w.address, `${name.toLowerCase().replace(/\W+/g, "")}@example.com`]);
    await db.query(`insert into applications(ref, handle, deployer_wallet, contact, mints, precheck, stage, bench_rank, developer_id) values ($1,$2,$3,$4,$5,$6,'bench',$7,$8)`, [`TW-B${i + 1}`, name, w.address, `${name}@example.com`, [], { score: 92 - i * 4, launches: 5 + i }, i + 1, d.id]);
  }
  /* a record: settled launches over the last two seasons with snapshots, positions and reports; a couple live */
  const season = seasonInfo(clock.now, anchor); let n = 0;
  for (const dev of devs) {
    const seat = devs.indexOf(dev) + 1; const launches = seat <= 14 ? 2 : 1;
    for (let k = 0; k < launches; k++) {
      const ago = 8 + Math.floor(r() * 44) + k * 5; // 8–57 days ago
      const slot = slotAt(clock.now - ago * DAY, 0, r() > 0.5 ? 14 : 20); const mint = chain.newMint(); const ticker = TICKERS[seat - 1] + (k ? String(k + 1) : "");
      const cap = 25_000 + Math.round(r() * 60_000); const peak = 1.4 + r() * (seat <= 10 ? 9 : 3); const end = seat <= 12 ? 1.1 + r() * 2.5 : 0.5 + r() * 1.2;
      const status = ago >= 30 ? "settled" : ago >= 14 ? "open" : "live";
      chain.create(mint, dev.wallet.address, slot); chain.assets.set(mint, { supply: 1e15, decimals: 6, symbol: ticker });
      await db.query(`insert into launches(mint, ticker, seat, developer_id, launched_at, slot_at, creation_tx, venue, supply, decimals, launch_cap_usd, dev_allocation_pct, liquidity, status, settled_at)
        values ($1,$2,$3,$4,$5,$5,$6,'PUMP_FUN',1e15,6,$7,$8,$9,$10,$11)`, [mint, ticker, seat, dev.id, new Date(slot), "sig" + mint.slice(0, 10), cap, +(1 + r() * 3.5).toFixed(2), r() > 0.3 ? "locked 12 months · Streamflow" : "burned", status, status === "settled" ? new Date(slot + 30 * DAY) : null]);
      const points = Math.min(ago, 30) * 4; let holders = 40;
      for (let p = 0; p <= points; p++) {
        const t = slot + p * 6 * 3_600_000; if (t > clock.now) break; const x = p / Math.max(1, points); const mult = x < 0.3 ? 1 + (peak - 1) * (x / 0.3) : peak - (peak - end) * ((x - 0.3) / 0.7);
        holders = Math.max(holders, Math.round(40 + 1800 * Math.sqrt(x) * (0.6 + r() * 0.8)));
        await db.query(`insert into launch_snapshots(mint, at, mcap_usd, holders, price_usd, liquidity_usd) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [mint, new Date(t), (cap * mult).toFixed(2), holders, (cap * mult / 1e9).toFixed(12), (8000 + cap * 0.2).toFixed(2)]);
      }
      const priceNow = cap * (status === "settled" ? end : peak) / 1e9;
      for (let h = 0; h < 60; h++) { const w = wallet(); const entryMult = 1 + r() * (peak - 1) * (status === "settled" ? 1.2 : 0.8); await db.query(`insert into holder_positions(mint, owner, tokens, cost_usd, first_seen) values ($1,$2,$3,$4,$5)`, [mint, w.address, "1000000000000", (1000 * cap * entryMult / 1e9).toFixed(6), new Date(slot + r() * 3 * DAY)]); }
      chain.quotes.set(mint, { priceUsd: priceNow, mcapUsd: priceNow * 1e9, liquidityUsd: 8000 + cap * 0.2 });
      if (status === "settled") await db.query(`insert into launch_holder_outcomes(mint, holders_at_or_above_entry_pct, holders_counted, price_usd) values ($1,$2,60,$3)`, [mint, (seat <= 12 ? 55 + r() * 35 : 20 + r() * 30).toFixed(2), priceNow]);
      for (const which of [7, 30] as const) { const due = slot + which * DAY; await db.query(`insert into reports(mint, which, due_at, filed_at, url) values ($1,$2,$3,$4,$5)`, [mint, which, new Date(due), due < clock.now - DAY ? new Date(due - 3_600_000 * (seat === 17 && which === 7 ? -30 : 6)) : null, due < clock.now - DAY ? `https://x.com/${dev.handle.replace(/\W/g, "")}/status/${1_800_000_000_000 + n}` : null]); }
      await db.query(`update seats set last_launch_at = greatest(coalesce(last_launch_at, $2), $2) where seat=$1`, [seat, new Date(slot)]);
      await db.query(`insert into events(type, at, seat, mint, payload) values ('launch_live', $1, $2, $3, $4)`, [new Date(slot), seat, mint, { ticker, launch_cap_usd: cap, dev_pct: 2, liquidity: "locked", bond_sol: 50 }]);
      n++;
    }
  }
  /* treasury + pools: what the fees so far add up to */
  const feeL = Number(lamports(PAD.SLOT_FEE_SOL));
  for (let i = 0; i < n; i++) { await db.query(`insert into ledger(account, entry, lamports) values ('seat_pool','slot fee · pool share',$1),('treasury','slot fee · treasury share',$2)`, [Math.round(feeL * PAD.FEE_SPLIT.pool), Math.round(feeL * PAD.FEE_SPLIT.treasury)]); }
  /* two seats hold upcoming slots */
  for (const [k, seat] of [3, 8].entries()) { const dev = devs[seat - 1]; const slot = slotAt(clock.now, 3 + k, k ? 20 : 14); await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, fee_tx, expires_at, confirmed_at) values ($1,$2,$3,'confirmed',$4,$5,'demo',$6,now())`, [new Date(slot), seat, dev.id, `TW-SLOT${seat}`, feeL, new Date(clock.now + DAY)]); await db.query(`insert into events(type, seat, payload) values ('slot_booked',$1,$2)`, [seat, { slot_time: new Date(slot).toISOString().slice(0, 16).replace("T", " "), score: 0 }]); }
  await runScoreCron(ctx);
  await db.query(`insert into elections(season, polls_open, polls_close) values ($1,$2,$3) on conflict do nothing`, [season.season, new Date(season.start + 20 * DAY), new Date(season.end)]);
  for (const b of BENCH.slice(0, 3)) { const { rows: [d] } = await db.query(`select id from developers where handle=$1`, [b]); await db.query(`insert into election_candidates(season, developer_id, statement, confirmed_at) values ($1,$2,$3,now()) on conflict do nothing`, [season.season, d.id, `${b}: two launches a season, every wallet disclosed, reports on day 6 and day 29.`]); }
  return { db, chain, ctx, treasury, devs };
}

const { db, chain, ctx, treasury, devs } = await seed();
const app = await build({ pool: db, helius: chain.helius(), ctx: { now: () => clock.now, anchorMs: anchor, treasury: treasury.address, fetch: chain.fetch(), oracle: disabledOracle, sendPush: ctx.sendPush } });
/* demo-only: what was pushed, newest first; and a confirmed slot 15 minutes ahead for a seat (to watch the reminder arrive) */
app.get("/demo/pushes", async () => pushLog);
app.post<{ Body: { seat: number } }>("/demo/slot-soon", { schema: { body: { type: "object", required: ["seat"], properties: { seat: { type: "integer", minimum: 1, maximum: 20 } } } } }, async (req) => {
  const { rows: [d] } = await db.query(`select developer_id from seats where seat=$1`, [req.body.seat]);
  const at = new Date(Math.ceil((clock.now + 15 * 60_000) / 60_000) * 60_000);
  await db.query(`alter table bookings drop constraint if exists bookings_slot_at_check`).catch(() => {}); // (no longer needed, kept for old databases)
  await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, fee_tx, expires_at, confirmed_at) values ($1,$2,$3,'confirmed',$4,3000000000,'demo',$1,now())`, [at, req.body.seat, d.developer_id, "SLOT-SOON" + Date.now().toString(36).toUpperCase().slice(-6)]);
  return { ok: true, seat: req.body.seat, slot_at: at.toISOString(), reminder_within_s: 40 };
});
await recoverRuns(ctx);
/* demo-only: a page served from a public origin (a dev tunnel, say) may reach this loopback API — Chrome's Private Network Access asks for this header on the preflight */
app.addHook("onSend", async (req, reply, payload) => { if (req.headers["access-control-request-private-network"]) reply.header("access-control-allow-private-network", "true"); return payload; });
/* demo-only: "pay" a memo on the scripted chain (slot fees) — the billing job picks it up on its next tick */
app.post<{ Body: { memo: string; from?: string; sol?: number } }>("/demo/pay", { schema: { body: { type: "object", required: ["memo"], properties: { memo: { type: "string", pattern: "^SLOT-[A-Z0-9]{3,24}$" }, from: { type: "string" }, sol: { type: "number", minimum: 0 } } } } }, async (req) => {
  const { rows: [b] } = await db.query(`select b.fee_lamports::text as lamports, d.deployer_wallet as wallet from bookings b join developers d on d.id = b.developer_id where b.memo=$1`, [req.body.memo]);
  const sig = chain.pay(req.body.memo, req.body.from ?? b?.wallet ?? devs[0].wallet.address, treasury.address, req.body.sol != null ? Math.round(req.body.sol * 1e9) : Number(b?.lamports ?? 0));
  return { ok: true, signature: sig, picked_up_within_s: 30 };
});
let stopping = false;
const loop = async () => { if (stopping) return; try { await dispatchOnce(db, null, chain.fetch(), ctx.sendPush).catch((e) => console.error("dispatch", e)); const ran = await tick(ctx, JOBS.filter((j) => j.name !== "indexer")); const names = ran.filter((x) => x.ran).map((x) => x.name); if (names.length) console.log(`[${new Date(clock.now).toISOString().slice(11, 19)}] jobs: ${names.join(", ")}`); } catch (e) { console.error(e); } if (!stopping) setTimeout(loop, 30_000); };
await app.listen({ port: PORT, host: "127.0.0.1" });
const s = seasonInfo(clock.now, anchor);
console.log(`\nCadre · demo pad\n  API      http://localhost:${PORT}/v1/pad   (seats, slots, launches, log, status, election …)\n  season   ${s.season} · day ${s.day} · ${devs.length} seats seated · ${SPEED}× clock\n  site     set web/config.js → API_BASE = "http://localhost:${PORT}" and open web/index.html\n  wallet   ${process.env.DEMO_WALLET ? `seat 01 belongs to ${process.env.DEMO_WALLET}` : "set DEMO_WALLET=<your address> to hold seat 01 and act with your wallet"}\n  treasury ${treasury.address}  (slot fees are paid here with the memo the API returns; the demo chain credits them instantly)\n`);
loop();
const stop = () => { stopping = true; app.close().then(() => db.end()).finally(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
