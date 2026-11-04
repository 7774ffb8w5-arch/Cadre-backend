/**
 * Slot-fee billing: a 3 SOL transfer to the treasury with a `SLOT-XXXXXXXX` memo confirms the booking it belongs to
 * (fee split 50/50 seat pool / treasury). There are no subscriptions and no API keys. Memo parsing follows the
 * SPL Memo program (data is the UTF-8 text).
 */
import { PAD, type Db } from "@twenty/shared";
import { emit, ledger, splitSlotFee, tx as inTx, pad2 } from "./ctx.js";
import type { Helius, ParsedTx } from "@twenty/scanner";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex")); let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}
export function base58Decode(s: string): Buffer {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const hex = n.toString(16); const buf = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  let zeros = 0; for (const c of s) { if (c === "1") zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), buf]);
}

/** Extract memo text from a parsed transaction (Helius exposes raw instructions with base58 data). */
export function memoOf(tx: ParsedTx & { instructions?: { programId: string; data: string }[] }): string | null {
  for (const ix of tx.instructions ?? []) {
    if (ix.programId !== MEMO_PROGRAM) continue;
    try { return base58Decode(ix.data).toString("utf8"); } catch { return ix.data; }
  }
  return null;
}

/**
 * One polling pass over the treasury's recent transactions. Idempotent: a signature is only processed once.
 * One memo family: SLOT-… (3 SOL slot fee → booking confirmed, fee split §9).
 * Challenges are free: there is no payment memo for them.
 */
export async function pollPayments(helius: Helius, pool: Db, treasuryOwner: string, _ctx?: unknown): Promise<number> {
  const txs = (await helius.transactions(treasuryOwner, { limit: 50 })) as (ParsedTx & { instructions?: { programId: string; data: string }[] })[];
  let issued = 0;
  for (const tx of txs) {
    const memo = memoOf(tx); if (!memo) continue;
    if (/^SLOT-[0-9A-F]{8}$/.test(memo)) { if (await settleSolMemo(pool, treasuryOwner, tx, memo)) issued++; continue; }
  }
  return issued;
}

/** SOL transfers with a SLOT- memo confirm the booking they belong to. */
export async function settleSolMemo(pool: Db, treasuryOwner: string, tx: ParsedTx, memo: string): Promise<boolean> {
  const lamports = (tx.nativeTransfers ?? []).filter((t) => t.toUserAccount === treasuryOwner).reduce((a, t) => a + BigInt(Math.round(t.amount)), 0n);
  if (lamports <= 0n) return false;
  if (memo.startsWith("SLOT-")) {
    const { rows: [b] } = await pool.query(`select b.id, b.seat, b.slot_at, b.fee_lamports, d.handle from bookings b join developers d on d.id = b.developer_id where b.memo=$1 and b.status='pending'`, [memo]);
    if (!b) return false;
    if (lamports * 1000n < BigInt(b.fee_lamports) * 995n) { await pool.query(`update bookings set fee_tx=$2 where id=$1 and fee_tx is null`, [b.id, "underpaid:" + tx.signature]); return false; }
    await inTx(pool, async (q) => {
      const upd = await q.query(`update bookings set status='confirmed', fee_tx=$2, confirmed_at=now() where id=$1 and status='pending' returning id`, [b.id, tx.signature]);
      if (!upd.rowCount) return;
      await splitSlotFee(q, BigInt(b.fee_lamports), b.seat, tx.signature);
      const { rows: [sc] } = await q.query(`select score from scores where seat=$1 order by day desc limit 1`, [b.seat]);
      await emit(q, "slot_booked", { seat: b.seat, payload: { slot_time: new Date(b.slot_at).toISOString().slice(0, 16).replace("T", " "), developer: b.handle, score: sc?.score ?? null, fee_sol: Number(b.fee_lamports) / 1e9 } });
    });
    return true;
  }
  return false;
}
