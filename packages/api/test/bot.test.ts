/** Telegram bot: lookup commands, self-service subscriptions, routing of events to subscribers, daily digest. A fake bot records sends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, ANCHOR } from "./_harness.js";
import { dispatchOnce, runDigest, registerCommands, subWants, leaderboard, seatCard, nextLaunches, latestBans, systemStatus, watch, unwatch, watching, toggleEvent, setDigest, setMuted, stopAll, getSub, esc, digestDue } from "@twenty/bot";

const clock = { now: ANCHOR + 21 * 86_400_000 + 9 * 3_600_000 };
const db = await freshDb(clock);
const sent: { chat: string; text: string }[] = []; let blocked = new Set<string>();
const fakeBot = { api: { sendMessage: async (chat: string, text: string) => { if (blocked.has(chat)) throw Object.assign(new Error("Forbidden"), { error_code: 403 }); sent.push({ chat, text }); } } } as never;

await db.query(`insert into developers(id, handle, deployer_wallet, contact) values ('00000000-0000-0000-0000-000000000001','Ashgrove','W1','x'), ('00000000-0000-0000-0000-000000000002','Fenn<b>x</b>','W2','x')`);
await db.query(`update seats set developer_id = '00000000-0000-0000-0000-000000000001', status = 'seated' where seat = 1`);
await db.query(`update seats set developer_id = '00000000-0000-0000-0000-000000000002', status = 'notice' where seat = 2`);
const day = new Date(clock.now).toISOString().slice(0, 10);
await db.query(`insert into scores(seat, day, survival_pct, holder_outcome_pct, median_peak_x, warnings, score, rank, inputs) values (1,$1,80,60,2.5,0,91,1,'{}'), (2,$1,50,40,1.2,1,55,2,'{}')`, [day]);
await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, expires_at) values ($1,1,'00000000-0000-0000-0000-000000000001','confirmed','SLOT-TEST0001',3000000000,$2)`, [new Date(clock.now + 5 * 3_600_000), new Date(clock.now + 9e6)]);

test("lookups render and escape handles", async () => {
  const lb = await leaderboard(db); assert.match(lb, /🥇 <b>01<\/b> Ashgrove · 91/); assert.ok(!lb.includes("<b>x</b>"), "handle is escaped"); assert.match(lb, /⚠️/);
  assert.match(await seatCard(db, 1, clock.now), /Score <b>91<\/b> · rank #1[\s\S]*Next launch/);
  assert.match(await seatCard(db, 5, clock.now), /vacant/); assert.match(await seatCard(db, 99), /Usage/);
  assert.match(await nextLaunches(db, clock.now), /Seat 01 Ashgrove/);
  assert.match(await latestBans(db, clock.now), /No bans/);
  assert.match(await systemStatus(db), /No status|operational|Outage/);
  assert.equal(esc(`<a href="x">&`), "&lt;a href=\"x\"&gt;&amp;");
});

test("subscriptions: watch, unwatch, toggle, mute, digest, stop", async () => {
  assert.match(await watch(db, "100", 1), /Watching Seat 01/); assert.match(await watch(db, "100", 1), /Already/); assert.match(await watch(db, "100", 25), /Usage/);
  await watch(db, "100", 3); assert.deepEqual((await getSub(db, "100"))!.seats, [1, 3]);
  assert.match(await unwatch(db, "100", 3), /Stopped/); assert.match(await unwatch(db, "100", 9), /not watching/);
  assert.match(await watching(db, "100"), /Seats: 01/);
  const s = await toggleEvent(db, "100", "report_due"); assert.ok(s.events.includes("report_due")); assert.ok(!(await toggleEvent(db, "100", "report_due")).events.includes("report_due"));
  await toggleEvent(db, "100", "not_an_event"); assert.ok(!(await getSub(db, "100"))!.events.includes("not_an_event"));
  assert.equal(await setDigest(db, "100", true), true); assert.equal(await setDigest(db, "100"), false);
  await setMuted(db, "100", true); assert.equal((await getSub(db, "100"))!.muted, true); await stopAll(db, "100"); assert.equal(await getSub(db, "100"), null);
});

test("subWants: seat scope, pad-wide events, mute", () => {
  const base = { chat_id: "1", seats: [4], events: ["launch_live", "ban", "slot_soon"], muted: false, digest: false };
  assert.equal(subWants(base, { type: "launch_live", seat: 4 }), true);
  assert.equal(subWants(base, { type: "launch_live", seat: 5 }), false, "other seat");
  assert.equal(subWants(base, { type: "ban", seat: 9 }), true, "bans are pad-wide");
  assert.equal(subWants(base, { type: "decision", seat: 4 }), false, "event not enabled");
  assert.equal(subWants({ ...base, seats: [] }, { type: "launch_live", seat: 7 }), true, "empty list = all seats");
  assert.equal(subWants({ ...base, muted: true }, { type: "ban", seat: null }), false);
});

test("dispatch sends to matching subscribers only, drops blocked chats", async () => {
  await watch(db, "A", 1); await watch(db, "B", 2); await watch(db, "C", 1);
  blocked = new Set(["C"]); sent.length = 0;
  await db.query(`insert into events(type, at, seat, payload) values ('launch_live', $1, 1, '{"ticker":"ASH","launch_cap_usd":50000,"dev_pct":3,"liquidity":"burned"}')`, [new Date(clock.now)]);
  await dispatchOnce(db, fakeBot, (async () => new Response("")) as never, (async () => ({ ok: true })) as never);
  const to = sent.map((s) => s.chat).sort(); assert.deepEqual(to, ["A"], "B watches another seat, C is blocked");
  assert.match(sent[0].text, /parse|<b>Cadre<\/b>[\s\S]*LIVE · Seat 01 Ashgrove/); assert.equal(await getSub(db, "C"), null, "blocked chat removed");
  assert.ok(await getSub(db, "A") && await getSub(db, "B"));
  const { rows } = await db.query(`select count(*)::int as n from events where delivered_at is null`); assert.equal(rows[0].n, 0);
});

test("daily digest: once per day, not before 08:00 UTC, to channel and digest chats", async () => {
  await setDigest(db, "A", true); sent.length = 0; process.env.TELEGRAM_ALERTS_CHANNEL = "@chan";
  const at = (h: number) => Date.parse(day + `T${String(h).padStart(2, "0")}:00:00Z`);
  assert.equal(await runDigest(db, fakeBot, at(7)), false, "before 08:00");
  assert.equal(await runDigest(db, fakeBot, at(9)), true); assert.deepEqual(sent.map((s) => s.chat).sort(), ["@chan", "A"]); assert.match(sent[0].text, /Cadre daily/);
  assert.equal(await runDigest(db, fakeBot, at(10)), false, "only once per day"); assert.equal(await digestDue(db, at(23)), null);
  delete process.env.TELEGRAM_ALERTS_CHANNEL;
});

test("commands register without a network call", () => {
  const calls: string[] = []; const stub: Record<string, unknown> = { use() {}, on() {}, catch() {}, api: { setMyCommands: async () => {} }, command: (n: string) => calls.push(n) };
  registerCommands(stub as never, db);
  for (const c of ["start", "help", "leaderboard", "seat", "next", "live", "bans", "status", "watch", "unwatch", "watching", "alerts", "digest", "mute", "unmute", "stop"]) assert.ok(calls.includes(c), c);
});
