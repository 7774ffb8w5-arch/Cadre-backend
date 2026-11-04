/**
 * Shared context for routes and jobs: the database, the RPC client, the season anchor, the oracle, and the
 * small helpers everything emits through (events for the bot and the log, decisions for the public record,
 * ledger entries for the pools).
 */
import type { PushSender } from "@twenty/shared";
import type { Db, Queryable } from "@twenty/shared";
import { seasonInfo, PAD } from "@twenty/shared";
import type { Helius } from "@twenty/scanner";
import type { Oracle } from "./oracle.js";
import { createHash, randomBytes } from "node:crypto";

export interface Ctx {
  /** web push sender; tests and the demo inject a fake */
  sendPush?: PushSender;
  pool: Db;
  helius: Helius;
  anchorMs: number;
  oracle: Oracle;
  treasury: string | null;
  now: () => number;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  fetch: typeof fetch;
}

export const LAMPORTS = 1_000_000_000n;
export const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
export const season = (ctx: Ctx, nowMs = ctx.now()) => seasonInfo(nowMs, ctx.anchorMs);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Everything the pad does lands in `events`; the bot, the public log and the site's wire read it. */
export async function emit(q: Queryable, type: string, o: { seat?: number | null; mint?: string | null; payload?: Record<string, unknown> } = {}) {
  await q.query(`insert into events(type, seat, mint, payload) values ($1,$2,$3,$4)`, [type, o.seat ?? null, o.mint ?? null, JSON.stringify(o.payload ?? {})]);
}

/** §7 penalties the rulebook applies automatically are still decisions on the public record, marked 'auto'. */
export async function autoDecision(q: Queryable, d: { type: "Warning" | "Fine" | "Season" | "Election" | "Seat"; subject: string; outcome: string; payload?: Record<string, unknown>; seat?: number | null }) {
  const { rows: [r] } = await q.query(`insert into decisions(type, subject, outcome, payload, status, proposed_by, decided_at) values ($1,$2,$3,$4,'auto','oracle',now()) returning id`, [d.type, d.subject, d.outcome, JSON.stringify(d.payload ?? {})]);
  if (d.type === "Warning" || d.type === "Fine") {
    if (d.seat) await q.query(`update seats set season_flawed = true, updated_at = now() where seat=$1`, [d.seat]);
  }
  await emit(q, "decision", { seat: d.seat ?? null, payload: { type: d.type, subject: d.subject, outcome: d.outcome, vote: "rulebook", id: r.id } });
  return r.id as string;
}

/** Append-only money movements between the pad's accounts (lamports, signed). */
export async function ledger(q: Queryable, account: "treasury" | "seat_pool", entry: string, amount: bigint, counterparty?: string | null, tx?: string | null) {
  await q.query(`insert into ledger(account, entry, lamports, counterparty, tx) values ($1,$2,$3,$4,$5)`, [account, entry, amount.toString(), counterparty ?? null, tx ?? null]);
}

/** §9 — a slot fee is split 50 / 50 (seat pool / treasury) the moment it is confirmed. */
export async function splitSlotFee(q: Queryable, feeLamports: bigint, seat: number, tx: string | null) {
  const pool = (feeLamports * BigInt(Math.round(PAD.FEE_SPLIT.pool * 100))) / 100n;
  const tre = feeLamports - pool;
  await ledger(q, "seat_pool", `slot fee · seat ${pad2(seat)}`, pool, null, tx);
  await ledger(q, "treasury", `slot fee · seat ${pad2(seat)}`, tre, null, tx);
}

/** Runs `fn` inside one transaction on a dedicated client; rolls back on any throw. */
export async function tx<T>(pool: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); const out = await fn(c); await c.query("commit"); return out; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}

export const memoToken = (prefix: string) => prefix + "-" + randomBytes(4).toString("hex").toUpperCase();
