/**
 * A season of Cadre, end to end, on a real Postgres engine (PGlite) with a scripted chain:
 * booking → fee → launch → snapshots → reports → penalties → settle → score → committee → ban →
 * vetting → challenge → election → season close → scheduler. Run: npm test -w @twenty/api
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAD, verifyProof, leafHash } from "@twenty/shared";
import { slotBookable } from "@twenty/shared";
import { freshDb, FakeChain, wallet, signedHeaders, makeTestCtx, slotAt, ANCHOR, type Wallet } from "./_harness.js";
import { build } from "../src/server.js";
import { runLifecycle } from "../src/jobs/lifecycle.js";
import { snapshotOne } from "../src/jobs/snapshots.js";
import { runScoreCron } from "../src/jobs/score-cron.js";
import { runBans } from "../src/jobs/ban.js";
import { seasonClose, electionSnapshot } from "../src/jobs/season.js";
import { tick, JOBS } from "../src/jobs/runner.js";
import { pollPayments } from "../src/billing.js";
import { ballotMessage } from "../src/security.js";
import { sign } from "./_harness.js";

process.env.LOG_LEVEL = "silent"; process.env.KEY_PEPPER = "t"; process.env.RATE_LIMIT_PER_MINUTE = "0"; process.env.TRUST_PROXY = "false"; delete process.env.BOOKING_FEE_BYPASS;

const clock = { now: ANCHOR + 21 * 86_400_000 + 9 * 3_600_000 }; // season 1, day 22, 09:00 UTC
const db = await freshDb(clock); const chain = new FakeChain();
const treasury = wallet().address;
const ctx = makeTestCtx(db, chain, clock, treasury);
const app = await build({ pool: db, helius: ctx.helius, ctx: { now: ctx.now, fetch: ctx.fetch, anchorMs: ANCHOR, treasury, oracle: ctx.oracle } });
const devs: Wallet[] = [], committee: Wallet[] = [];
const post = (url: string, w: Wallet, action: Parameters<typeof signedHeaders>[1], body: unknown, method: "POST" | "PATCH" = "POST") => app.inject({ method, url, headers: signedHeaders(w, action, body, clock.now), payload: body as never });
const json = (r: { body: string }) => JSON.parse(r.body);
const SOL = 1e9;

test("seed: 20 seated developers, a committee of five", async () => {
  for (let i = 1; i <= 20; i++) {
    const w = wallet(); devs.push(w);
    const { rows: [d] } = await db.query(`insert into developers(handle, deployer_wallet, contact) values ($1,$2,$3) returning id`, [`dev${i}`, w.address, `dev${i}@example.com`]);
    await db.query(`update seats set developer_id=$2, status='seated', since_season=1 where seat=$1`, [i, d.id]);
  }
  for (let i = 1; i <= 5; i++) { const w = wallet(); committee.push(w); await db.query(`insert into committee_members(name, wallet, since_season, term_end_season) values ($1,$2,1,3)`, [`member${i}`, w.address]); }
  const seats = json(await app.inject({ method: "GET", url: "/v1/seats" }));
  assert.equal(seats.length, 20); assert.equal(seats[0].developer, "dev1"); assert.equal(seats[0].wallet, devs[0].address);
});

let bookingId = "", bookingMemo = "", slot1 = 0;
test("§1 booking: signed, 48 h ahead, one open booking per seat, paid by memo, fee split 50/50", async () => {
  slot1 = slotAt(clock.now, 3, 14);
  const bad = await app.inject({ method: "POST", url: "/v1/slots/book", payload: { slot_at: new Date(slot1).toISOString() } });
  assert.equal(bad.statusCode, 401, "unsigned request refused");
  const tooSoon = await post("/v1/slots/book", devs[0], "book slot", { slot_at: new Date(slotAt(clock.now, 1, 20)).toISOString() });
  assert.equal(tooSoon.statusCode, 409); assert.match(json(tooSoon).error, /48 h/);
  const notSlot = await post("/v1/slots/book", devs[0], "book slot", { slot_at: new Date(slot1 + 3_600_000 + 30_000).toISOString() });
  assert.equal(notSlot.statusCode, 409); assert.match(json(notSlot).error, /whole minute/);
  // launch times are free: any whole minute works, there is no 14:00/20:00 grid
  assert.equal(slotBookable(slot1 + 17 * 60_000, clock.now, { liveLaunchDay: null, hasBooking: false }).ok, true, "an off-grid time is bookable");
  assert.equal(slotBookable(slot1 + 30 * 60_000, clock.now, { liveLaunchDay: null, hasBooking: false }, [slot1]).ok, false, "two launches within 2 h are refused");
  assert.equal(slotBookable(slot1 + 150 * 60_000, clock.now, { liveLaunchDay: null, hasBooking: false }, [slot1]).ok, true, "2.5 h apart is fine");
  const wrongSigner = await app.inject({ method: "POST", url: "/v1/slots/book", headers: { ...signedHeaders(devs[0], "book slot", { slot_at: "x" }, clock.now) }, payload: { slot_at: new Date(slot1).toISOString() } });
  assert.equal(wrongSigner.statusCode, 401, "body swapped after signing");
  const r = await post("/v1/slots/book", devs[0], "book slot", { slot_at: new Date(slot1).toISOString() });
  assert.equal(r.statusCode, 200, r.body); const b = json(r); bookingId = b.booking_id; bookingMemo = b.memo;
  assert.equal(b.status, "pending"); assert.match(b.memo, /^SLOT-[0-9A-F]{8}$/); assert.equal(b.amount_sol, 3); assert.equal(b.pay_to, treasury);
  const twice = await post("/v1/slots/book", devs[0], "book slot", { slot_at: new Date(slotAt(clock.now, 4, 14)).toISOString() });
  assert.equal(twice.statusCode, 409); assert.match(json(twice).error, /already holds a slot/);
  const taken = await post("/v1/slots/book", devs[1], "book slot", { slot_at: new Date(slot1).toISOString() });
  assert.equal(taken.statusCode, 409); assert.match(json(taken).error, /already booked/);
  const slots = json(await app.inject({ method: "GET", url: "/v1/slots" }));
  assert.equal(slots.find((s: { time: string }) => s.time === new Date(slot1).toISOString()).seat, 1, "pending booking shows on the public calendar");
  // pay the fee: the watcher confirms it
  chain.pay(bookingMemo, devs[0].address, treasury, 3 * SOL);
  await pollPayments(ctx.helius, db, treasury);
  const { rows: [bk] } = await db.query(`select status, fee_tx, confirmed_at from bookings where id=$1`, [bookingId]);
  assert.equal(bk.status, "confirmed"); assert.ok(bk.fee_tx && bk.confirmed_at);
  const { rows: led } = await db.query(`select account, sum(lamports)::bigint as l from ledger group by account order by account`);
  assert.deepEqual(Object.fromEntries(led.map((x) => [x.account, Number(x.l) / SOL])), { seat_pool: 1.5, treasury: 1.5 });
  const { rows: ev } = await db.query(`select type, seat, payload from events where type='slot_booked'`);
  assert.equal(ev.length, 1); assert.equal(ev[0].seat, 1); assert.equal(ev[0].payload.developer, "dev1");
  await pollPayments(ctx.helius, db, treasury);
  const { rows: led2 } = await db.query(`select count(*)::int as n from ledger`); assert.equal(led2[0].n, 2, "a payment is processed once");
  const suspended = devs[4]; await db.query(`update seats set status='suspended' where seat=5`);
  const sus = await post("/v1/slots/book", suspended, "book slot", { slot_at: new Date(slotAt(clock.now, 3, 20)).toISOString() });
  assert.equal(sus.statusCode, 403); await db.query(`update seats set status='seated' where seat=5`);
});

let mint1 = "";
test("§6 launch registration: the chain decides (creator, slot window), reports scheduled, lock applies", async () => {
  clock.now = slot1 + 2 * 60_000; // two minutes into the slot
  mint1 = chain.newMint(); chain.create(mint1, devs[0].address, slot1 + 60_000);
  const foreign = chain.newMint(); chain.create(foreign, devs[1].address, slot1 + 60_000);
  const early = chain.newMint(); chain.create(early, devs[0].address, slot1 - 3 * 3_600_000);
  const wrongDev = await post("/v1/launches", devs[0], "register launch", { mint: foreign, liquidity: "burned" });
  assert.equal(wrongDev.statusCode, 403); assert.match(json(wrongDev).error, /not created by the seat wallet/);
  const tooEarly = await post("/v1/launches", devs[0], "register launch", { mint: early, liquidity: "burned" });
  assert.equal(tooEarly.statusCode, 409); assert.match(json(tooEarly).error, /outside a slot window/);
  assert.equal((await db.query(`select 1 from events where type='launch_rejected' and mint=$1`, [early])).rows.length, 1, "CA before launch is on the record");
  const over = await post("/v1/launches", devs[0], "register launch", { mint: mint1, liquidity: "burned", dev_allocation_pct: 7 });
  assert.equal(over.statusCode, 400, "dev allocation > 5 % refused by the schema");
  chain.quotes.set(mint1, { priceUsd: 0.001, mcapUsd: 1_000_000, liquidityUsd: 50_000 });
  chain.holders.set(mint1, [{ owner: "A".repeat(0) + wallet().address, amount: 1_000_000n * 1_000_000n }]);
  const ok = await post("/v1/launches", devs[0], "register launch", { mint: mint1, ticker: "wow", liquidity: "burned", dev_allocation_pct: 4.5, wallets: [{ label: "team", address: devs[0].address, pct: 4.5 }] });
  assert.equal(ok.statusCode, 200, ok.body); const l = json(ok);
  assert.equal(l.ticker, "WOW"); assert.equal(l.seat, 1); assert.equal(l.slot_at, new Date(slot1).toISOString()); assert.equal(l.first_snapshot.price_usd, 0.001);
  const { rows: reps } = await db.query(`select which, due_at from reports where mint=$1 order by which`, [mint1]);
  assert.deepEqual(reps.map((r) => r.which), [7, 30]); assert.equal(new Date(reps[0].due_at).getTime(), slot1 + 60_000 + 7 * 86_400_000);
  const { rows: [bk] } = await db.query(`select status from bookings where id=$1`, [bookingId]); assert.equal(bk.status, "launched");
  const { rows: [lc] } = await db.query(`select launch_cap_usd::float as c from launches where mint=$1`, [mint1]); assert.equal(lc.c, 1_000_000, "first snapshot fixes the launch cap");
  const dup = await post("/v1/launches", devs[0], "register launch", { mint: mint1, liquidity: "burned" }); assert.equal(dup.statusCode, 409);
  const feed = json(await app.inject({ method: "GET", url: "/v1/launches" }));
  assert.equal(feed[0].mint, mint1); assert.equal(feed[0].status, "live"); assert.equal(feed[0].reports.d7, "due"); assert.equal(feed[0].disclosed_wallets.length, 1);
  clock.now = slot1 + 2 * 86_400_000;
  const locked = await post("/v1/slots/book", devs[0], "book slot", { slot_at: new Date(slotAt(clock.now, 3, 14)).toISOString() });
  assert.equal(locked.statusCode, 409); assert.match(json(locked).error, /locked until day 14/);
});

const holderA = wallet(), holderB = wallet(), holderC = wallet();
test("§4 snapshots: cost basis follows buys at the snapshot price, sells shrink it pro rata", async () => {
  const T = 1_000_000n; // 1 token = 1e6 raw units
  chain.quotes.set(mint1, { priceUsd: 0.001, mcapUsd: 1_000_000 });
  chain.holders.set(mint1, [{ owner: holderA.address, amount: 1000n * T }, { owner: holderB.address, amount: 500n * T }, { owner: devs[0].address, amount: 45_000_000n * T }]);
  clock.now += 3_600_000; assert.equal((await snapshotOne(ctx, mint1)).ok, true);
  chain.quotes.set(mint1, { priceUsd: 0.002, mcapUsd: 2_000_000 });
  chain.holders.set(mint1, [{ owner: holderA.address, amount: 500n * T }, { owner: holderB.address, amount: 500n * T }, { owner: holderC.address, amount: 200n * T }, { owner: devs[0].address, amount: 45_000_000n * T }]);
  clock.now += 3_600_000; await snapshotOne(ctx, mint1);
  const { rows } = await db.query(`select owner, tokens, cost_usd::float as cost from holder_positions where mint=$1 order by owner`, [mint1]);
  const pos = Object.fromEntries(rows.map((r) => [r.owner, { tokens: Number(r.tokens) / 1e6, cost: r.cost }]));
  assert.equal(pos[holderA.address].cost, 0.5, "A bought 1000 at 0.001 (cost 1.00), sold half → 0.50");
  assert.equal(pos[holderB.address].cost, 0.5); assert.equal(pos[holderC.address].cost, 0.4, "C bought 200 at 0.002");
  const snaps = json(await app.inject({ method: "GET", url: `/v1/launches/${mint1}/snapshots` })); assert.equal(snaps.length, 3); assert.equal(snaps[2].price_usd, 0.002);
});

test("§7 reports: reminder, missing → warning, filing late is recorded, filing on time is clean", async () => {
  const launched = slot1 + 60_000;
  clock.now = launched + 6 * 86_400_000 + 3_600_000; // 24 h before the day-7 deadline
  let r = await runLifecycle(ctx); assert.equal(r.reminded, 1);
  assert.equal((await db.query(`select 1 from events where type='report_due' and mint=$1`, [mint1])).rows.length, 1);
  clock.now = launched + 8 * 86_400_000 + 3_600_000; // 25 h after the deadline
  r = await runLifecycle(ctx); assert.equal(r.warned, 1);
  const { rows: w } = await db.query(`select type, status, payload from decisions where type='Warning'`); assert.equal(w.length, 1); assert.equal(w[0].status, "auto"); assert.equal(w[0].payload.which, 7);
  assert.equal((await db.query(`select season_flawed from seats where seat=1`)).rows[0].season_flawed, true);
  assert.equal((await runLifecycle(ctx)).warned, 0, "idempotent");
  const late = await post(`/v1/launches/${mint1}/reports/7`, devs[0], "file report", { url: "https://x.com/dev1/status/1" });
  assert.equal(late.statusCode, 200); assert.equal(json(late).state, "late");
  assert.equal((await db.query(`select count(*)::int as n from decisions where type='Warning'`)).rows[0].n, 1, "no second warning for the same report");
  const again = await post(`/v1/launches/${mint1}/reports/7`, devs[0], "file report", { url: "https://x.com/dev1/status/2" }); assert.equal(again.statusCode, 409);
  const notMine = await post(`/v1/launches/${mint1}/reports/30`, devs[1], "file report", { url: "https://x.com/dev2/status/1" }); assert.equal(notMine.statusCode, 404);
  const feed = json(await app.inject({ method: "GET", url: "/v1/launches" })); assert.equal(feed[0].reports.d7, "late");
});

test("§7 missed slot: fee forfeited, 5 SOL fine, warning; cancelling with notice is clean", async () => {
  clock.now = slot1 + 9 * 86_400_000;
  const s2 = slotAt(clock.now, 3, 20);
  const b = json(await post("/v1/slots/book", devs[1], "book slot", { slot_at: new Date(s2).toISOString() }));
  chain.pay(b.memo, devs[1].address, treasury, 3 * SOL); await pollPayments(ctx.helius, db, treasury);
  clock.now = s2 + 61 * 60_000;
  const r = await runLifecycle(ctx); assert.equal(r.missed, 1);
  const { rows: [bk] } = await db.query(`select status from bookings where id=$1`, [b.booking_id]); assert.equal(bk.status, "missed");
  const { rows: fine } = await db.query(`select payload from decisions where type='Fine'`); assert.equal(fine.length, 1); assert.equal(fine[0].payload.fine_sol, 5);
  assert.equal((await db.query(`select missed_slots from seats where seat=2`)).rows[0].missed_slots, 1);
  // cancel with notice
  const s3 = slotAt(clock.now, 3, 14);
  const cr = await post("/v1/slots/book", devs[2], "book slot", { slot_at: new Date(s3).toISOString() }); assert.equal(cr.statusCode, 200, cr.body); const c = json(cr);
  chain.pay(c.memo, devs[2].address, treasury, 3 * SOL); await pollPayments(ctx.helius, db, treasury);
  const cancel = await post(`/v1/slots/${c.booking_id}/cancel`, devs[2], "cancel slot", {});
  assert.equal(cancel.statusCode, 200); assert.equal(json(cancel).status, "cancelled");
  const other = await post(`/v1/slots/${c.booking_id}/cancel`, devs[3], "cancel slot", {}); assert.equal(other.statusCode, 404, "another seat cannot cancel it");
  // unpaid booking expires after the pay window
  const d = json(await post("/v1/slots/book", devs[3], "book slot", { slot_at: new Date(slotAt(clock.now, 4, 14)).toISOString() }));
  clock.now += (PAD.BOOKING_PAY_WINDOW_MIN + 1) * 60_000;
  assert.equal((await runLifecycle(ctx)).expired, 1);
  assert.equal((await db.query(`select status from bookings where id=$1`, [d.booking_id])).rows[0].status, "expired");
  const free = await post("/v1/slots/book", devs[4], "book slot", { slot_at: d.slot_at }); assert.equal(free.statusCode, 200, "the slot is free again");
});

let mintAuto = "";
test("auto-detection: a creation in the indexed window is registered from chain data, disclosure follows", async () => {
  const s4 = slotAt(clock.now, 3, 20);
  const b = json(await post("/v1/slots/book", devs[5], "book slot", { slot_at: new Date(s4).toISOString() }));
  chain.pay(b.memo, devs[5].address, treasury, 3 * SOL); await pollPayments(ctx.helius, db, treasury);
  mintAuto = chain.newMint(); chain.create(mintAuto, devs[5].address, s4 + 30_000);
  await db.query(`insert into deployer_index(mint, deployer, created_at, signature, venue) values ($1,$2,$3,$4,'PUMP_FUN')`, [mintAuto, devs[5].address, new Date(s4 + 30_000), "sigauto"]);
  clock.now = s4 + 20 * 60_000;
  const r = await runLifecycle(ctx); assert.equal(r.detected, 1); assert.equal(r.missed, 0);
  const { rows: [l] } = await db.query(`select liquidity, status, precheck from launches where mint=$1`, [mintAuto]); assert.equal(l.liquidity, "undisclosed"); assert.equal(l.precheck.auto, true);
  const dis = await post(`/v1/launches/${mintAuto}`, devs[5], "register launch", { liquidity: "locked Streamflow until 2027-01-01", dev_allocation_pct: 2, wallets: [] }, "PATCH");
  assert.equal(dis.statusCode, 200, dis.body);
  assert.equal((await db.query(`select liquidity from launches where mint=$1`, [mintAuto])).rows[0].liquidity, "locked Streamflow until 2027-01-01");
});

test("day 30: settled with the holder outcome (insiders excluded), then the score write", async () => {
  const launched = slot1 + 60_000;
  chain.quotes.set(mint1, { priceUsd: 0.0015, mcapUsd: 1_500_000 });
  clock.now = launched + 30 * 86_400_000 + 3_600_000;
  const r = await runLifecycle(ctx); assert.ok(r.settled >= 1);
  const { rows: [o] } = await db.query(`select holders_at_or_above_entry_pct::float as pct, holders_counted from launch_holder_outcomes where mint=$1`, [mint1]);
  assert.equal(o.holders_counted, 3, "A, B, C — the developer is excluded");
  assert.equal(o.pct, 66.67, "A (avg 0.001) and B (0.001) are at or above 0.0015; C bought at 0.002");
  assert.equal((await db.query(`select status from launches where mint=$1`, [mint1])).rows[0].status, "settled");
  const scored = await runScoreCron(ctx);
  assert.equal(scored.length, 20);
  const s1 = scored.find((s) => s.seat === 1)!;
  assert.equal(s1.metrics.survivalPct, 100, "d30 cap 1.5 M > launch cap 1 M"); assert.equal(s1.metrics.holderOutcomePct, 66.67); assert.equal(s1.metrics.warnings, 1);
  const inputs = json(await app.inject({ method: "GET", url: "/v1/seats/1/inputs" })); assert.equal(inputs.inputs_hash.length, 64); assert.equal(inputs.inputs.launches.length, 1);
  const seats = json(await app.inject({ method: "GET", url: "/v1/seats" })); assert.equal(seats[0].score, s1.score); assert.equal(seats[0].rank, s1.rank);
  assert.equal(s1.provisional, false); assert.equal(scored.find((s) => s.seat === 2)!.provisional, true, "no settled launch yet → provisional");
  assert.equal(scored.filter((s) => s.status === "notice").length, 0, "a fresh pad puts nobody on notice");
});

test("committee: 3 of 5 execute; a ban blocks the wallets, vacates the seat and pays nothing", async () => {
  const propose = async (w: Wallet, body: unknown) => json(await post("/v1/committee/decisions", w, "propose decision", body));
  const vote = (w: Wallet, id: string, v: "for" | "against") => post(`/v1/committee/decisions/${id}/vote`, w, "committee vote", { vote: v });
  const outsider = await post("/v1/committee/decisions", devs[0], "propose decision", { type: "Warning", subject: "Seat 03", outcome: "warning", payload: { seat: 3 } }); assert.equal(outsider.statusCode, 403);
  const w1 = await propose(committee[0], { type: "Warning", subject: "Seat 03 · conduct", outcome: "warning for a dark channel", payload: { seat: 3, reason: "channels dark 5 days" } });
  assert.equal(w1.status, "proposed"); assert.equal(w1.votes_for, 1);
  assert.equal(json(await vote(committee[1], w1.id, "for")).status, "proposed");
  const done = json(await vote(committee[2], w1.id, "for")); assert.equal(done.status, "executed");
  assert.equal((await db.query(`select season_flawed from seats where seat=3`)).rows[0].season_flawed, true);
  assert.equal((await vote(committee[3], w1.id, "for")).statusCode, 409, "no votes after execution");
  const rej = await propose(committee[0], { type: "Fine", subject: "Seat 04", outcome: "2 SOL", payload: { seat: 4, fine_sol: 2 } });
  await vote(committee[1], rej.id, "against"); await vote(committee[2], rej.id, "against"); assert.equal(json(await vote(committee[3], rej.id, "against")).status, "rejected");
  const badBan = await post("/v1/committee/decisions", committee[0], "propose decision", { type: "Ban", subject: "s", outcome: "o", payload: { seat: 2, mint: mint1, reason: "dev sold inside the vest" } });
  assert.equal(badBan.statusCode, 400, "mint must belong to the seat");
  const sl = await propose(committee[0], { type: "Ban", subject: "Seat 01 · $WOW", outcome: "dev wallet sold inside the vest — permanent ban, no payout", payload: { seat: 1, mint: mint1, reason: "dev wallet sold 2.1 % on day 12" } });
  await vote(committee[1], sl.id, "for"); assert.equal(json(await vote(committee[4], sl.id, "for")).status, "executed");
  const { rows: [brow] } = await db.query(`select id, executed_at from bans where mint=$1`, [mint1]); assert.equal(brow.executed_at, null, "the ban job executes it");
  assert.equal(await runBans(ctx), 1); assert.equal(await runBans(ctx), 0, "idempotent");
  assert.equal((await db.query(`select status from launches where mint=$1`, [mint1])).rows[0].status, "banned");
  const { rows: [seat1] } = await db.query(`select status, developer_id from seats where seat=1`); assert.equal(seat1.status, "vacant"); assert.equal(seat1.developer_id, null);
  const { rows: bw } = await db.query(`select address from banned_wallets where ban_id=$1`, [brow.id]); assert.ok(bw.some((w) => w.address === devs[0].address), "the developer wallet is blocked for good");
  const feed = json(await app.inject({ method: "GET", url: "/v1/launches" })); const banned = feed.find((l: { mint: string }) => l.mint === mint1); assert.equal(banned.status, "banned"); assert.match(banned.banned.reason, /sold 2\.1/);
  const list = json(await app.inject({ method: "GET", url: "/v1/bans" })); assert.equal(list.length, 1); assert.equal(list[0].seat, 1);
  const { rows: money } = await db.query(`select count(*)::int as n from ledger where entry ilike '%slash%' or entry ilike '%payout%'`); assert.equal(money[0].n, 0, "a ban moves no money");
  const wal = json(await app.inject({ method: "GET", url: `/v1/wallets/${devs[0].address}` })); assert.equal(wal.banned, true);
});

const applicant = wallet(); let appRef = "", appId = "";
test("§2/§11 vetting: apply → interview → public review → flags, bounty, lock → bench", async () => {
  const mints = [chain.newMint(), chain.newMint(), chain.newMint()]; mints.forEach((m, i) => chain.create(m, applicant.address, clock.now - (i + 2) * 30 * 86_400_000));
  const few = await post("/v1/apply", applicant, "apply", { handle: "newdev", mints: mints.slice(0, 2), contact: "newdev@example.com" }); assert.equal(few.statusCode, 400, "three launches minimum");
  const r = await post("/v1/apply", applicant, "apply", { handle: "@newdev", mints, contact: "newdev@example.com" });
  assert.equal(r.statusCode, 200, r.body); const a = json(r); appRef = a.ref; assert.equal(a.stage, "onchain"); assert.equal(a.precheck.launches.length, 3);
  assert.equal((await post("/v1/apply", applicant, "apply", { handle: "newdev", mints, contact: "x@y.z" })).statusCode, 409, "one open application per wallet");
  const pub = json(await app.inject({ method: "GET", url: `/v1/applications/${appRef}` })); assert.equal(pub.handle, "newdev"); assert.equal(pub.contact, undefined, "contact never served");
  const { rows: [ar] } = await db.query(`select id from applications where ref=$1`, [appRef]); appId = ar.id;
  const propose = async (w: Wallet, body: unknown) => json(await post("/v1/committee/decisions", w, "propose decision", body));
  const vote = (w: Wallet, id: string, v: "for" | "against") => post(`/v1/committee/decisions/${id}/vote`, w, "committee vote", { vote: v });
  const bench = await propose(committee[0], { type: "Bench", subject: "newdev", outcome: "interview passed — to public review", payload: { application_id: appId } });
  await vote(committee[1], bench.id, "for"); await vote(committee[2], bench.id, "for");
  assert.equal((await db.query(`select stage from applications where id=$1`, [appId])).rows[0].stage, "public_review");
  const flagger = wallet();
  const self = await post(`/v1/applications/${appRef}/flags`, applicant, "flag application", { claim: "I flag myself for fun", evidence: ["https://solscan.io/tx/abc"] }); assert.equal(self.statusCode, 409);
  const f1r = await post(`/v1/applications/${appRef}/flags`, flagger, "flag application", { claim: "deployer sold inside the vest on launch two", evidence: ["https://solscan.io/tx/abc"] }); assert.equal(f1r.statusCode, 200, f1r.body); const f1 = json(f1r);
  assert.ok(f1.flag_id);
  // discarded flags: three in a row lock the wallet
  for (let i = 0; i < 3; i++) {
    const { rows: [f] } = await db.query(`insert into review_flags(application_id, filer_wallet, evidence, claim) values ($1,$2,$3,$4) returning id`, [appId, flagger.address + (i ? String(i) : ""), ["https://x"], "claim " + i]);
    const d = await propose(committee[0], { type: "Bounty", subject: "flag", outcome: "no evidence — discarded", payload: { flag_id: f.id, upheld: false } });
    await vote(committee[1], d.id, "for"); await vote(committee[2], d.id, "for");
    await db.query(`update review_flags set filer_wallet=$2 where id=$1`, [f.id, flagger.address]);
  }
  const d0 = await propose(committee[0], { type: "Bounty", subject: "flag", outcome: "discarded", payload: { flag_id: f1.flag_id, upheld: false } });
  await vote(committee[1], d0.id, "for"); await vote(committee[2], d0.id, "for");
  assert.equal((await db.query(`select 1 from locked_wallets where wallet=$1`, [flagger.address])).rows.length, 1, "three discarded flags lock the wallet");
  assert.equal((await post(`/v1/applications/${appRef}/flags`, flagger, "flag application", { claim: "another one please", evidence: ["https://x"] })).statusCode, 403);
  assert.equal((await runLifecycle(ctx)).benched, 0, "review window still open");
  clock.now += (PAD.PUBLIC_REVIEW_HOURS + 1) * 3_600_000;
  assert.equal((await runLifecycle(ctx)).benched, 1);
  const { rows: [ap] } = await db.query(`select stage, bench_rank, developer_id from applications where id=$1`, [appId]); assert.equal(ap.stage, "bench"); assert.equal(ap.bench_rank, 1); assert.ok(ap.developer_id);
  const pad = json(await app.inject({ method: "GET", url: "/v1/pad" })); assert.deepEqual(pad.bench, ["newdev"]);
  const me = json(await app.inject({ method: "GET", url: `/v1/wallets/${applicant.address}` })); assert.equal(me.application.stage, "bench"); assert.equal(me.seat, null);
});

test("§5 challenge: signal any time, file in the window with public evidence, holder signal, committee decides", async () => {
  { const seasonLen = PAD.SEASON_DAYS * 86_400_000; clock.now = ANCHOR + Math.floor((clock.now - ANCHOR) / seasonLen) * seasonLen + 10 * 86_400_000; } // mid-season
  const sig = await post("/v1/challenges", applicant, "challenge", { seat: 7, kind: "signal" }); assert.equal(sig.statusCode, 200, sig.body);
  const notBench = await post("/v1/challenges", devs[6], "challenge", { seat: 7, kind: "signal" }); assert.equal(notBench.statusCode, 403);
  const closed = await post("/v1/challenges", applicant, "challenge", { seat: 7, kind: "filed" }); assert.equal(closed.statusCode, 409); assert.match(json(closed).error, /replacement window/);
  // into the window: last 72 h of the current season
  const seasonLen = PAD.SEASON_DAYS * 86_400_000, idx = Math.floor((clock.now - ANCHOR) / seasonLen); clock.now = ANCHOR + (idx + 1) * seasonLen - 10 * 3_600_000;
  const noEv = await post("/v1/challenges", applicant, "challenge", { seat: 7, kind: "filed" }); assert.equal(noEv.statusCode, 400, "public evidence is required");
  const filed = json(await post("/v1/challenges", applicant, "challenge", { seat: 7, kind: "filed", evidence: "Seat 07 skipped two reports, see https://example.com/evidence" })); assert.equal(filed.status, "filed"); assert.equal(filed.memo, undefined, "free to file: no payment");
  const { rows: [ch] } = await db.query(`select status from challenges where id=$1`, [filed.id]); assert.equal(ch.status, "filed");
  // seat 7 launches so a holder exists
  const m7 = chain.newMint(); const s7 = slotAt(clock.now - 20 * 86_400_000, 0, 14); chain.create(m7, devs[6].address, s7 + 1000);
  const { rows: [d7] } = await db.query(`select id from developers where deployer_wallet=$1`, [devs[6].address]);
  await db.query(`insert into launches(mint, ticker, seat, developer_id, launched_at, slot_at, supply, decimals, dev_allocation_pct, liquidity, status) values ($1,'SEV',7,$2,$3,$3,1000000000000000,6,1,'burned','open')`, [m7, d7.id, new Date(s7)]);
  await db.query(`insert into holder_positions(mint, owner, tokens, cost_usd, first_seen) values ($1,$2,$3,1,now())`, [m7, holderA.address, "2000000000000"]);
  const hv = await post(`/v1/challenges/${filed.id}/holder-vote`, holderA, "holder vote", { vote: "keep" }); assert.equal(hv.statusCode, 200, hv.body); assert.equal(json(hv).weight_pct, 0.2);
  const none = await post(`/v1/challenges/${filed.id}/holder-vote`, holderC, "holder vote", { vote: "replace" }); assert.equal(none.statusCode, 403);
  const list = json(await app.inject({ method: "GET", url: "/v1/challenges?seat=7" })); assert.equal(list[0].keep_pct, 0.2); assert.equal(list[0].votes, 1);
  const propose = async (w: Wallet, body: unknown) => json(await post("/v1/committee/decisions", w, "propose decision", body));
  const vote = (w: Wallet, id: string, v: "for" | "against") => post(`/v1/committee/decisions/${id}/vote`, w, "committee vote", { vote: v });
  const dec = await propose(committee[0], { type: "Challenge", subject: "Seat 07 · newdev vs dev7", outcome: "replaced", payload: { challenge_id: filed.id, result: "replaced" } });
  await vote(committee[1], dec.id, "for"); assert.equal(json(await vote(committee[2], dec.id, "for")).status, "executed");
  const { rows: [seat7] } = await db.query(`select s.status, d.handle from seats s join developers d on d.id = s.developer_id where seat=7`); assert.equal(seat7.handle, "newdev"); assert.equal(seat7.status, "seated", "no bond: the new developer is seated at once");
});

test("§12 election: candidacy, confirmation, snapshot, signed ballot, result at the cut; season close", async () => {
  const seasonLen = PAD.SEASON_DAYS * 86_400_000; const idx = Math.floor((clock.now - ANCHOR) / seasonLen); const nextStart = ANCHOR + (idx + 1) * seasonLen; const seasonNo = idx + 2;
  // a bench developer for the election
  const cand = wallet(); const { rows: [cd] } = await db.query(`insert into developers(handle, deployer_wallet, contact) values ('people', $1, 'p@x.y') returning id`, [cand.address]);
  await db.query(`insert into applications(ref, handle, deployer_wallet, contact, mints, stage, bench_rank, developer_id) values ('TW-A-AAAAAA','people',$1,'p@x.y','{}','bench',2,$2)`, [cand.address, cd.id]);
  clock.now = nextStart + 2 * 86_400_000; // day 3: nominations
  const c = await post("/v1/election/candidacy", cand, "declare candidacy", { statement: "holders first" }); assert.equal(c.statusCode, 200, c.body);
  const propose = async (w: Wallet, body: unknown) => json(await post("/v1/committee/decisions", w, "propose decision", body));
  const vote = (w: Wallet, id: string, v: "for" | "against") => post(`/v1/committee/decisions/${id}/vote`, w, "committee vote", { vote: v });
  const conf = await propose(committee[0], { type: "Election", subject: "people", outcome: "eligible", payload: { developer_id: cd.id } }); await vote(committee[1], conf.id, "for"); await vote(committee[2], conf.id, "for");
  // a launch this season with holders → the snapshot
  const mS = chain.newMint(); const sS = slotAt(clock.now, 1, 14); chain.create(mS, devs[9].address, sS + 1000);
  const { rows: [d10] } = await db.query(`select id from developers where deployer_wallet=$1`, [devs[9].address]);
  await db.query(`insert into launches(mint, ticker, seat, developer_id, launched_at, slot_at, supply, decimals, dev_allocation_pct, liquidity, status) values ($1,'TEN',10,$2,$3,$3,1000000000000000,6,1,'burned','live')`, [mS, d10.id, new Date(sS)]);
  await db.query(`insert into holder_positions(mint, owner, tokens, cost_usd, first_seen) values ($1,$2,$3,1,now()), ($1,$4,$5,1,now())`, [mS, holderA.address, "10000000000000", holderB.address, "1000000000000"]);
  clock.now = nextStart + 19 * 86_400_000 + 60_000; // day 20
  const snap = await electionSnapshot(ctx, seasonNo); assert.equal(snap.wallets, 2);
  const { rows: sn } = await db.query(`select wallet, weight_pct::float as w from election_snapshot where season=$1 order by w desc`, [seasonNo]); assert.equal(sn[0].w, 1, "A holds 1 % of supply"); assert.equal(sn[1].w, 0.1);
  clock.now = nextStart + 22 * 86_400_000; // polls
  const issued = new Date(clock.now).toISOString(), nonce = "ballot-" + Math.random().toString(36).slice(2, 14);
  const ballot = (w: Wallet, candidate: string) => app.inject({ method: "POST", url: "/v1/election/ballot", payload: { wallet: w.address, candidate, nonce: nonce + w.address.slice(0, 4), issued_at: issued, signature: sign(w, ballotMessage(seasonNo, candidate, nonce + w.address.slice(0, 4), issued)) } });
  const bA = await ballot(holderA, "people"); assert.equal(bA.statusCode, 200, bA.body); assert.equal(json(bA).weight_pct, 0.5, "capped at 0.5 % of supply");
  const bC = await ballot(holderC, "people"); assert.equal(bC.statusCode, 403, "not in the snapshot");
  const el = json(await app.inject({ method: "GET", url: "/v1/election" })); assert.equal(el.phase, "polls"); assert.equal(el.candidates[0].handle, "people"); assert.equal(el.candidates[0].weight_pct, 0.5);
  // two seats with a bad record this season: settled launches that ended below their launch cap
  const badLaunch = async (seat: number, at: Date) => {
    const m = chain.newMint();
    const { rows: [dv] } = await db.query(`select developer_id from seats where seat=$1`, [seat]);
    await db.query(`insert into launches(mint, ticker, seat, developer_id, launched_at, slot_at, launch_cap_usd, dev_allocation_pct, liquidity, status, settled_at) values ($1,'BAD',$2,$3,$4,$4,1000000,1,'burned','settled',$4)`, [m, seat, dv.developer_id, at]);
    await db.query(`insert into launch_snapshots(mint, at, mcap_usd, holders, price_usd) values ($1,$2,400000,10,0.0004)`, [m, new Date(at.getTime() + 29 * 86_400_000)]);
    await db.query(`insert into launch_holder_outcomes(mint, holders_at_or_above_entry_pct, holders_counted) values ($1,0,10)`, [m]);
  };
  for (const seat of [11, 12]) await badLaunch(seat, new Date(nextStart + 2 * 86_400_000));
  // the cut: day 1 of the following season
  clock.now = nextStart + seasonLen + 20 * 60_000;
  await runScoreCron(ctx);
  const close = await seasonClose(ctx, seasonNo); assert.equal(close.closed, true);
  const { rows: [e2] } = await db.query(`select result, tally_root from elections where season=$1`, [seasonNo]); assert.equal(e2.result, "people"); assert.equal(e2.tally_root.length, 64);
  const { rows: [s20] } = await db.query(`select d.handle, s.status from seats s join developers d on d.id = s.developer_id where s.seat=20`); assert.equal(s20.handle, "people"); assert.equal(s20.status, "seated");
  const { rows: [dec] } = await db.query(`select payload from decisions where type='Season' and payload->>'close'=$1`, [String(seasonNo)]); assert.deepEqual([...dec.payload.notice].sort(), [11, 12], "the two seats with a record below the threshold are on notice; provisional seats are not");
  assert.equal((await seasonClose(ctx, seasonNo)).closed, false, "closing twice is a no-op");
  const notice = dec.payload.notice as number[];
  const { rows: ns } = await db.query(`select seat, notice_seasons, status from seats where seat in (11, 12)`); assert.deepEqual(ns.map((x) => [x.notice_seasons, x.status]), [[1, "notice"], [1, "notice"]], JSON.stringify(ns));
  // second consecutive close on notice → vacated (the record stays bad in the following season too)
  void notice;
  for (const seat of [11, 12]) await badLaunch(seat, new Date(nextStart + seasonLen + 2 * 86_400_000));
  const nextNo = seasonNo + 1; clock.now = nextStart + 2 * seasonLen + 20 * 60_000; await runScoreCron(ctx);
  const close2 = await seasonClose(ctx, nextNo);
  const { rows: dbg } = await db.query(`select seat, status, notice_seasons from seats where seat in (11,12)`);
  assert.ok(close2.vacated.length >= 1, "a seat on notice twice in a row is vacated: " + JSON.stringify({ close2, dbg }));
  assert.equal((await db.query(`select status from seats where seat=$1`, [close2.vacated[0]])).rows[0].status, "vacant");
});

test("scheduler: jobs run under advisory locks, land in job_runs, show in /v1/status", async () => {
  await tick(ctx, JOBS.filter((j) => j.name === "lifecycle" || j.name === "bans"));
  const { rows } = await db.query(`select name, ok from job_runs order by id`); assert.ok(rows.some((r) => r.name === "lifecycle" && r.ok)); assert.ok(rows.some((r) => r.name === "bans" && r.ok));
  const before = rows.length; await tick(ctx, JOBS.filter((j) => j.name === "lifecycle")); assert.equal((await db.query(`select count(*)::int as n from job_runs`)).rows[0].n, before, "not due again yet");
  // a failed run is retried after five minutes, a healthy one waits its full cadence
  const boom = { name: "boom", every: 60 * 60_000, run: async () => { throw new Error("rpc down"); } };
  await tick(ctx, [boom]); clock.now += 6 * 60_000; await tick(ctx, [boom]);
  assert.equal((await db.query(`select count(*)::int as n from job_runs where name='boom'`)).rows[0].n, 2, "failed job retried after 5 min");
  await db.query(`update job_runs set ok=true where name='boom'`); clock.now += 6 * 60_000; await tick(ctx, [boom]);
  assert.equal((await db.query(`select count(*)::int as n from job_runs where name='boom'`)).rows[0].n, 2, "successful job waits for its cadence");
  // an interrupted run (process died) is marked failed on start-up
  await db.query(`insert into job_runs(name) values ('zombie')`); const { recoverRuns } = await import("../src/jobs/runner.js"); await recoverRuns(ctx);
  assert.equal((await db.query(`select ok from job_runs where name='zombie'`)).rows[0].ok, false);
  const st = json(await app.inject({ method: "GET", url: "/v1/status" })); assert.ok(st.jobs.find((j: { name: string }) => j.name === "lifecycle")); assert.equal(st.oracle, null);
  const dec = json(await app.inject({ method: "GET", url: "/v1/decisions?limit=5" })); assert.ok(dec.length >= 1);
});

test("status page: probes fill /v1/health, three bad probes open an incident, a good one resolves it", async () => {
  const { runHealth } = await import("../src/jobs/health.js");
  await runHealth(ctx);
  const h = json(await app.inject({ method: "GET", url: "/v1/health" }));
  assert.ok(["operational", "degraded", "outage"].includes(h.overall), h.overall);
  const names = h.components.map((c: { component: string }) => c.component);
  for (const n of ["api", "database", "scheduler", "chain", "market", "leaderboard", "payments", "alerts", "program"]) assert.ok(names.includes(n), n);
  assert.equal(h.components.find((c: { component: string }) => c.component === "database").state, "operational");
  assert.ok(h.daily.length >= 1);
  await db.query(`update health_state set state='down', bad_streak=2 where component='alerts'`);
  await db.query(`insert into events(type, payload) values ('slot_booked','{}')`); await db.query(`update events set at = now() - interval '2 hours' where delivered_at is null`);
  await runHealth(ctx);
  const { rows: open } = await db.query(`select title from incidents where component='alerts' and resolved_at is null`); assert.equal(open.length, 1);
  await db.query(`update events set delivered_at = now() where delivered_at is null`);
  await runHealth(ctx);
  assert.equal((await db.query(`select count(*)::int as n from incidents where component='alerts' and resolved_at is null`)).rows[0].n, 0);
});

test.after(async () => { await app.close(); await db.end(); });
