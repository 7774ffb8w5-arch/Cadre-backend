/**
 * One-tap payments: the API prepares exactly the transfer the database says is owed (amount, destination and memo
 * never come from the caller), the transaction decodes to [system transfer, memo], and the status route follows the
 * booking from pending to confirmed once the billing poll has seen the transfer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction, SystemProgram, SystemInstruction, PublicKey } from "@solana/web3.js";
import { freshDb, FakeChain, wallet, makeTestCtx, slotAt, ANCHOR } from "./_harness.js";
import { build } from "../src/server.js";
import { pollPayments } from "../src/billing.js";
import { MEMO_PROGRAM, solanaPayUrl, paymentFor } from "../src/routes/pay.js";

process.env.LOG_LEVEL = "silent"; process.env.RATE_LIMIT_PER_MINUTE = "0"; process.env.KEY_PEPPER = "t";
const clock = { now: ANCHOR + 21 * 86_400_000 + 9 * 3_600_000 };
const db = await freshDb(clock); const chain = new FakeChain(); const treasury = wallet(); const payer = wallet();
const ctx = makeTestCtx(db, chain, clock, treasury.address);
const app = await build({ pool: db, helius: chain.helius(), ctx: { now: () => clock.now, anchorMs: ANCHOR, treasury: treasury.address, fetch: chain.fetch(), oracle: ctx.oracle } });
const json = (r: { body: string }) => JSON.parse(r.body);
const prepare = (body: unknown) => app.inject({ method: "POST", url: "/v1/pay/prepare", payload: body as object });
let devId = ""; const MEMO = "SLOT-AB12CD34";

test("seed: a pending booking and a pending challenge", async () => {
  const { rows: [d] } = await db.query(`insert into developers(handle, deployer_wallet, contact) values ('Sable', $1, 's@example.com') returning id`, [payer.address]); devId = d.id;
  await db.query(`update seats set developer_id=$1, status='seated', since_season=1 where seat=7`, [d.id]);
  const slot = slotAt(clock.now, 2, 14);
  await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, expires_at) values ($1, 7, $2, 'pending', $3, 3000000000, $4)`, [new Date(slot), d.id, MEMO, new Date(clock.now + 2 * 3_600_000)]);
});

test("prepare: the transaction is [transfer to the treasury, memo] for the payer, amount from the booking", async () => {
  const r = await prepare({ memo: MEMO, payer: payer.address }); assert.equal(r.statusCode, 200, r.body); assert.equal(r.headers["cache-control"], "no-store");
  const j = json(r); assert.equal(j.amount_sol, 3); assert.equal(j.pay_to, treasury.address); assert.equal(j.seat, 7);
  const tx = Transaction.from(Buffer.from(j.transaction, "base64"));
  assert.equal(tx.feePayer!.toBase58(), payer.address); assert.equal(tx.recentBlockhash, j.blockhash); assert.equal(tx.instructions.length, 2);
  const [t, m] = tx.instructions;
  assert.ok(t.programId.equals(SystemProgram.programId)); const dec = SystemInstruction.decodeTransfer(t);
  assert.equal(dec.fromPubkey.toBase58(), payer.address); assert.equal(dec.toPubkey.toBase58(), treasury.address); assert.equal(dec.lamports, 3_000_000_000n);
  assert.equal(m.programId.toBase58(), MEMO_PROGRAM); assert.equal(Buffer.from(m.data).toString("utf8"), MEMO);
  assert.equal(tx.signatures.every((s) => s.signature === null), true, "nothing is signed server-side");
  const u = new URL(j.solana_pay.replace("solana:", "https://x/")); assert.equal(j.solana_pay.startsWith("solana:" + treasury.address + "?"), true);
  assert.equal(u.searchParams.get("amount"), "3"); assert.equal(u.searchParams.get("memo"), MEMO);
});

test("prepare: the caller chooses only who pays", async () => {
  assert.equal((await prepare({ memo: MEMO, payer: payer.address, amount: 0.001 })).statusCode, 400, "no amount field");
  assert.equal((await prepare({ memo: MEMO, payer: payer.address, pay_to: payer.address })).statusCode, 400, "no destination field");
  assert.equal((await prepare({ memo: "SLOT-ZZZZZZZZ", payer: payer.address })).statusCode, 400, "memo pattern");
  assert.equal((await prepare({ memo: "TW-AB12CD34", payer: payer.address })).statusCode, 400, "only SLOT- here");
  assert.equal((await prepare({ memo: MEMO, payer: "not a wallet" })).statusCode, 400);
  assert.equal((await prepare({ memo: MEMO, payer: "1".repeat(44) })).statusCode, 400, "a 44-char string that is not a key");
  assert.equal((await prepare({ memo: "SLOT-00000000", payer: payer.address })).statusCode, 404, "unknown memo");
});

test("status follows the booking: pending → confirmed after the billing poll; confirmed memos cannot be prepared again", async () => {
  assert.equal(json(await app.inject({ method: "GET", url: `/v1/pay/status/${MEMO}` })).state, "pending");
  chain.pay(MEMO, payer.address, treasury.address, 3_000_000_000); await pollPayments(chain.helius(), db, treasury.address);
  const s = json(await app.inject({ method: "GET", url: `/v1/pay/status/${MEMO}` })); assert.equal(s.state, "confirmed"); assert.ok(s.at);
  assert.equal((await prepare({ memo: MEMO, payer: payer.address })).statusCode, 404, "paid → nothing left to prepare");
  assert.equal((await app.inject({ method: "GET", url: `/v1/pay/status/SLOT-11111111` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/v1/pay/status/not-a-memo` })).statusCode, 400);
});

test("expired bookings cannot be paid; challenges are free and have no payment", async () => {
  const slot = slotAt(clock.now, 3, 20);
  await db.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, expires_at) values ($1, 7, $2, 'pending', 'SLOT-EEEEEEEE', 3000000000, $3)`, [new Date(slot), devId, new Date(clock.now - 1000)]);
  assert.equal((await prepare({ memo: "SLOT-EEEEEEEE", payer: payer.address })).statusCode, 404, "past its hold");
  assert.equal(json(await app.inject({ method: "GET", url: "/v1/pay/status/SLOT-EEEEEEEE" })).state, "expired");
  assert.equal((await prepare({ memo: "CHAL-0F0F0F0F", payer: payer.address })).statusCode, 400, "no challenge payments exist any more");
});

test.after(async () => { await app.close(); await db.end(); });
