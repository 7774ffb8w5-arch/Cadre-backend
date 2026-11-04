/**
 * Web push: subscribe/unsubscribe/test routes, scope matching, the 15-minute slot reminder, and delivery by the bot
 * with a fake sender (no push service is contacted).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushMatches, pushMessageFor, isKnownPushEndpoint, PUSH_DEFAULT_EVENTS, type PushSender } from "@twenty/shared";
import { freshDb, FakeChain, wallet, makeTestCtx, slotAt, ANCHOR } from "./_harness.js";
import { build } from "../src/server.js";
import { runLifecycle } from "../src/jobs/lifecycle.js";
import { dispatchOnce, pushEvent } from "@twenty/bot";

process.env.LOG_LEVEL = "silent"; process.env.RATE_LIMIT_PER_MINUTE = "0"; process.env.KEY_PEPPER = "t";
process.env.VAPID_PUBLIC_KEY = "BPtestpublickey_tests_only_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const clock = { now: ANCHOR + 21 * 86_400_000 + 9 * 3_600_000 };
const db = await freshDb(clock); const chain = new FakeChain(); const treasury = wallet();
const sent: { endpoint: string; title: string; tag?: string }[] = []; let fail: "gone" | "error" | null = null;
const fakeSend: PushSender = async (sub, msg) => { if (fail === "gone") return { ok: false, gone: true, status: 410 }; if (fail === "error") return { ok: false, gone: false, status: 500 }; sent.push({ endpoint: sub.endpoint, title: msg.title, tag: msg.tag }); return { ok: true, gone: false, status: 201 }; };
const ctx = makeTestCtx(db, chain, clock, treasury.address); ctx.sendPush = fakeSend;
const app = await build({ pool: db, helius: chain.helius(), ctx: { now: () => clock.now, anchorMs: ANCHOR, treasury: treasury.address, fetch: chain.fetch(), oracle: ctx.oracle, sendPush: fakeSend } });
const json = (r: { body: string }) => JSON.parse(r.body);
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwxyz0123456789";
const sub = (endpoint = ENDPOINT) => ({ endpoint, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

test("seed: one developer on seat 7", async () => {
  const w = wallet(); const { rows: [d] } = await db.query(`insert into developers(handle, deployer_wallet, contact) values ('Sable', $1, 's@example.com') returning id`, [w.address]);
  await db.query(`update seats set developer_id=$1, status='seated', since_season=1 where seat=7`, [d.id]);
  const key = json(await app.inject({ method: "GET", url: "/v1/push/key" })); assert.equal(key.enabled, false, "no private key in tests → not configured, but the public key is served"); assert.ok(key.public_key);
});

test("subscribe: validated, upserted, scoped; unknown push hosts refused unless opened", async () => {
  const bad = await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub("https://evil.example.com/push"), seats: [7] } });
  assert.equal(bad.statusCode, 400); assert.match(bad.body, /known push service/);
  assert.equal((await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub("http://fcm.googleapis.com/x"), seats: [7] } })).statusCode, 400, "http refused by the schema");
  assert.equal((await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), seats: [21] } })).statusCode, 400, "seat out of range");
  assert.equal((await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), events: ["nope"] } })).statusCode, 400, "unknown event");
  const ok = await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), seats: [7], events: ["slot_soon", "report_due"] } });
  assert.equal(ok.statusCode, 200, ok.body); assert.deepEqual(json(ok).seats, [7]); assert.equal(ok.headers["cache-control"], "no-store");
  const again = await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), seats: [7, 3] } });
  assert.deepEqual(json(again).seats, [7, 3]); assert.equal(json(again).events, "default");
  assert.equal((await db.query(`select count(*)::int as n from push_subscriptions`)).rows[0].n, 1, "upsert by endpoint");
  assert.equal(isKnownPushEndpoint("https://web.push.apple.com/QAbc"), true); assert.equal(isKnownPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"), true); assert.equal(isKnownPushEndpoint("https://example.com/"), false);
});

test("matching: seats, event lists, defaults and pad-wide events", () => {
  assert.equal(pushMatches({ seats: [7], events: [] }, { type: "slot_soon", seat: 7 }), true);
  assert.equal(pushMatches({ seats: [7], events: [] }, { type: "slot_soon", seat: 8 }), false);
  assert.equal(pushMatches({ seats: [], events: [] }, { type: "slot_soon", seat: 8 }), true, "empty seats = every seat");
  assert.equal(pushMatches({ seats: [7], events: [] }, { type: "tier_change", seat: 7 }), false, "not in the default set");
  assert.equal(pushMatches({ seats: [7], events: ["tier_change"] }, { type: "tier_change", seat: 7 }), true);
  assert.equal(pushMatches({ seats: [7], events: ["season_close"] }, { type: "season_close", seat: null }), true, "pad-wide");
  assert.ok(PUSH_DEFAULT_EVENTS.includes("slot_soon"));
  const m = pushMessageFor({ type: "slot_soon", seat: 7, payload: { minutes: 15, slot_time: "2026-11-04T14:00:00.000Z" } }, "Seat 07 Sable launches in 15 min (14:00 UTC).", "https://cadre-us.org#seat-07");
  assert.equal(m.title, "Seat 07 launches in 15 min"); assert.equal(m.tag, "slot_soon-7"); assert.equal(m.url, "https://cadre-us.org#seat-07");
});

test("the 15-minute reminder is emitted once per confirmed slot and delivered to matching subscriptions", async () => {
  const { rows: [d] } = await db.query(`select developer_id from seats where seat=7`);
  const slot = slotAt(clock.now, 1, 14);
  await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, fee_tx, expires_at, confirmed_at) values ($1, 7, $2, 'confirmed', 'SLOT-PUSHTEST', 3000000000, 'tx', $3, now())`, [new Date(slot), d.developer_id, new Date(slot)]);
  clock.now = slot - 16 * 60_000; await runLifecycle(ctx);
  assert.equal((await db.query(`select count(*)::int as n from events where type='slot_soon'`)).rows[0].n, 1, "reminder emitted inside the 20-minute window");
  clock.now = slot - 12 * 60_000; await runLifecycle(ctx);
  assert.equal((await db.query(`select count(*)::int as n from events where type='slot_soon'`)).rows[0].n, 1, "never twice");
  // a second browser watches seat 3 only; a third wants everything
  await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub("https://updates.push.services.mozilla.com/wpush/v2/seat3only"), seats: [3] } });
  await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub("https://web.push.apple.com/everything"), seats: [], events: ["slot_soon", "launch_live", "season_close"] } });
  sent.length = 0; await dispatchOnce(db, null, chain.fetch(), fakeSend);
  assert.deepEqual(sent.map((x) => x.endpoint).sort(), [ENDPOINT, "https://web.push.apple.com/everything"].sort(), "seat 7 subscriber and the everything subscriber, not the seat-3 watcher");
  assert.match(sent[0].title, /^Seat 07 launches in 1[0-9] min$/);
  assert.equal((await db.query(`select delivered_at is not null as d from events where type='slot_soon'`)).rows[0].d, true);
});

test("delivery failures: gone → deleted, errors → counted and disabled after 20", async () => {
  const ev = { id: 1, at: new Date().toISOString(), type: "launch_live", seat: 7, mint: null, payload: { ticker: "SABLE" } };
  fail = "gone"; await pushEvent(db, ev, "live", "https://x", fakeSend);
  assert.equal((await db.query(`select count(*)::int as n from push_subscriptions`)).rows[0].n, 1, "two gone subscriptions deleted; the seat-3 watcher did not match and stays");
  await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), seats: [7] } });
  fail = "error"; for (let i = 0; i < 20; i++) await pushEvent(db, ev, "live", "https://x", fakeSend);
  assert.equal((await db.query(`select disabled_at is not null as off, failures from push_subscriptions where endpoint=$1`, [ENDPOINT])).rows[0].off, true, "disabled after 20 consecutive failures");
  fail = null;
  const t = await app.inject({ method: "POST", url: "/v1/push/test", payload: { endpoint: ENDPOINT } }); assert.equal(t.statusCode, 404, "a disabled subscription cannot be tested");
  await app.inject({ method: "POST", url: "/v1/push/subscribe", payload: { subscription: sub(), seats: [7] } });
  sent.length = 0; const t2 = await app.inject({ method: "POST", url: "/v1/push/test", payload: { endpoint: ENDPOINT } }); assert.equal(json(t2).ok, true); assert.equal(sent[0].tag, "test");
  const del = await app.inject({ method: "DELETE", url: "/v1/push/subscribe", payload: { endpoint: ENDPOINT } }); assert.equal(json(del).removed, 1);
});

test.after(async () => { await app.close(); await db.end(); });
