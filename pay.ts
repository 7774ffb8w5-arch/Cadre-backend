/**
 * One-tap payments. Slot fees are plain SOL transfers with a memo the API issued. These routes only *describe*
 * and *prepare* that transfer — nothing here signs, holds or moves funds:
 *
 *   POST /v1/pay/prepare   {memo, payer}  → the unsigned transfer (system transfer + memo) for the payer's wallet to
 *                                           sign, plus a Solana Pay link for wallets that scan or open links
 *   GET  /v1/pay/status/:memo             → pending | confirmed | expired, so the page can show progress
 *
 * Amount, destination and memo come from the database row the memo belongs to; the caller chooses only who pays.
 * The page re-parses the transaction before the wallet sees it (web/dev.js), and the scheduler still decides what
 * counts as paid (billing.ts) — a prepared transaction that is never sent costs nothing.
 */
import type { FastifyInstance } from "fastify";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Ctx } from "../ctx.js";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_RE = "^SLOT-[0-9A-F]{8}$";
const WALLET_RE = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";

export interface PreparedPayment { memo: string; kind: "slot"; amount_sol: number; lamports: string; pay_to: string; seat: number; expires_at: string | null; label: string; message: string }

/** What the memo is for, straight from the tables. `null` when it is unknown, paid or expired. */
export async function paymentFor(ctx: Ctx, memo: string): Promise<PreparedPayment | null> {
  if (!ctx.treasury) return null;
  if (memo.startsWith("SLOT-")) {
    const { rows: [b] } = await ctx.pool.query(`select seat, slot_at, fee_lamports, expires_at from bookings where memo=$1 and status='pending' and expires_at > $2`, [memo, new Date(ctx.now())]);
    if (!b) return null;
    const lamports = BigInt(b.fee_lamports);
    return { memo, kind: "slot", amount_sol: Number(lamports) / 1e9, lamports: lamports.toString(), pay_to: ctx.treasury, seat: b.seat, expires_at: new Date(b.expires_at).toISOString(), label: "Cadre", message: `Slot fee · Seat ${String(b.seat).padStart(2, "0")} · ${new Date(b.slot_at).toISOString().slice(0, 16).replace("T", " ")} UTC` };
  }
  return null;
}

/** Solana Pay transfer request (https://docs.solanapay.com/spec) — opens in Phantom, Solflare, Backpack and on phones. */
export function solanaPayUrl(p: PreparedPayment): string {
  const q = new URLSearchParams({ amount: String(p.amount_sol), label: p.label, message: p.message, memo: p.memo });
  return `solana:${p.pay_to}?${q.toString().replace(/\+/g, "%20")}`;
}

/** The unsigned legacy transaction: [system transfer payer → treasury, memo]. Serialised without signatures. */
export function buildTransfer(p: PreparedPayment, payer: string, blockhash: string): Uint8Array {
  const from = new PublicKey(payer);
  const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(p.pay_to), lamports: BigInt(p.lamports) }));
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [{ pubkey: from, isSigner: true, isWritable: false }], data: Buffer.from(p.memo, "utf8") }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

export async function payRoutes(app: FastifyInstance, ctx: Ctx) {
  let cached: { hash: string; last: number; at: number } | null = null;
  async function blockhash() {
    if (cached && ctx.now() - cached.at < 20_000) return cached;
    const r = await ctx.helius.rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    cached = { hash: r.value.blockhash, last: r.value.lastValidBlockHeight, at: ctx.now() }; return cached;
  }

  app.post<{ Body: { memo: string; payer: string } }>("/v1/pay/prepare", {
    schema: { body: { type: "object", additionalProperties: false, required: ["memo", "payer"], properties: { memo: { type: "string", pattern: MEMO_RE }, payer: { type: "string", pattern: WALLET_RE } } } },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!ctx.treasury) return reply.code(503).send({ error: "payments are not configured on this pad" });
    const p = await paymentFor(ctx, req.body.memo);
    if (!p) return reply.code(404).send({ error: "nothing to pay for that memo — it is paid, expired or unknown" });
    try { new PublicKey(req.body.payer); } catch { return reply.code(400).send({ error: "payer is not a valid wallet address" }); }
    let bh; try { bh = await blockhash(); } catch (e) { ctx.log.warn({ err: (e as Error).message }, "blockhash"); return reply.code(503).send({ error: "the network is busy — try again in a moment" }); }
    const bytes = buildTransfer(p, req.body.payer, bh.hash);
    return { ...p, payer: req.body.payer, transaction: Buffer.from(bytes).toString("base64"), blockhash: bh.hash, last_valid_block_height: bh.last, solana_pay: solanaPayUrl(p), memo_program: MEMO_PROGRAM };
  });

  app.get<{ Params: { memo: string } }>("/v1/pay/status/:memo", {
    schema: { params: { type: "object", required: ["memo"], properties: { memo: { type: "string", pattern: MEMO_RE } } } },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    reply.header("cache-control", "no-store"); const memo = req.params.memo;
    {
      const { rows: [b] } = await ctx.pool.query(`select status, expires_at, confirmed_at, seat from bookings where memo=$1`, [memo]);
      if (!b) return reply.code(404).send({ error: "unknown memo" });
      const expired = b.status === "pending" && new Date(b.expires_at).getTime() <= ctx.now();
      return { memo, kind: "slot", seat: b.seat, state: b.status === "confirmed" ? "confirmed" : expired || b.status === "expired" ? "expired" : b.status === "pending" ? "pending" : b.status, at: b.confirmed_at ? new Date(b.confirmed_at).toISOString() : null };
    }
    return reply.code(404).send({ error: "unknown memo" });
  });
}
