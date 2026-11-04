/**
 * Launch registration (§1, §6). Shared by `POST /v1/launches` (the developer registers at launch) and the
 * lifecycle job (a creation found on chain for a booked slot is registered from chain data, disclosure pending).
 *
 * The chain decides the facts: the mint's creation transaction must be signed by the seat's wallet and sit
 * inside the booked slot's window (−5 min … +60 min). A mint created earlier is a "CA before launch" breach and
 * is refused; the committee sees it in the log.
 */
import { PAD, slotFor, type Queryable } from "@twenty/shared";
import { creation, scanLaunch, knownFundingParents } from "@twenty/scanner";
import type { Ctx } from "./ctx.js";
import { emit, tx, pad2 } from "./ctx.js";
import { seatOf } from "./auth.js";
import { snapshotOne } from "./jobs/snapshots.js";

export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

export interface DisclosedWallet { label: string; address: string; pct: number }
export interface RegisterInput { wallet: string; mint: string; ticker: string | null; devAllocationPct: number | null; liquidity: string; wallets: DisclosedWallet[]; auto?: boolean }

const TICKER = (s: unknown) => { const t = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); return t || "TOKEN"; };

export async function registerLaunch(ctx: Ctx, input: RegisterInput) {
  const seat = await seatOf(ctx.pool, input.wallet);
  if (!seat) throw new HttpError(403, "wallet holds no seat");
  if (seat.status === "suspended") throw new HttpError(403, "seat is suspended (30 days after an abandoned launch)");
  const { rows: dup } = await ctx.pool.query(`select 1 from launches where mint=$1`, [input.mint]);
  if (dup.length) throw new HttpError(409, "launch already registered");
  const create = await creation({ helius: ctx.helius }, input.mint);
  if (!create) throw new HttpError(404, "mint creation not found on chain yet — try again in a minute");
  if (create.feePayer !== input.wallet) throw new HttpError(403, "mint was not created by the seat wallet");
  const launchedAtMs = create.timestamp * 1000;
  const { rows: seatSlots } = await ctx.pool.query(`select slot_at from bookings where seat=$1 and status='confirmed' and slot_at >= $2 and slot_at <= $3`, [seat.seat, new Date(launchedAtMs - PAD.LAUNCH_EARLY_TOLERANCE_MIN * 60_000), new Date(launchedAtMs + PAD.LAUNCH_LATE_TOLERANCE_MIN * 60_000)]);
  const slotMs = slotFor(launchedAtMs, seatSlots.map((r: { slot_at: Date }) => new Date(r.slot_at).getTime()));
  if (!slotMs) {
    await emit(ctx.pool, "launch_rejected", { seat: seat.seat, mint: input.mint, payload: { why: "created outside a slot window", created_at: new Date(launchedAtMs).toISOString(), rule: "§6 no CA before launch" } });
    throw new HttpError(409, "mint was created outside a slot window (−5 min … +60 min) — not a pad launch");
  }
  const { rows: [booking] } = await ctx.pool.query(`select id, fee_lamports from bookings where seat=$1 and slot_at=$2 and status='confirmed'`, [seat.seat, new Date(slotMs)]);
  if (!booking) throw new HttpError(409, "no confirmed booking for this slot");
  const asset = await ctx.helius.asset(input.mint).catch(() => null);
  const ticker = TICKER(input.ticker ?? asset?.content?.metadata?.symbol);
  const supply = asset?.token_info?.supply ?? null, decimals = asset?.token_info?.decimals ?? null;
  const ctxScan = { helius: ctx.helius, knownFundingParents: await knownFundingParents(ctx.pool).catch(() => new Map()) };
  const precheck = await scanLaunch(ctxScan, input.wallet, input.mint, launchedAtMs).catch((e: Error) => ({ error: e.message, flags: 0, checks: [] as unknown[] }));
  const flags = Number((precheck as { flags?: number }).flags ?? 0);
  const devPct = input.devAllocationPct ?? 0;
  if (devPct < 0 || devPct > PAD.DEV_ALLOCATION_MAX_PCT) throw new HttpError(400, `dev allocation must be 0–${PAD.DEV_ALLOCATION_MAX_PCT} %`);
  const wallets = validateWallets(input.wallets);
  await tx(ctx.pool, async (q) => {
    await q.query(`insert into launches(mint, ticker, seat, developer_id, booking_id, launched_at, slot_at, creation_tx, venue, supply, decimals, dev_allocation_pct, liquidity, precheck)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [input.mint, ticker, seat.seat, seat.developer_id, booking.id, new Date(launchedAtMs), new Date(slotMs), create.signature, create.source || "unknown", supply === null ? null : String(supply), decimals, devPct, input.liquidity, JSON.stringify({ ...precheck, auto: Boolean(input.auto), disclosed: !input.auto })]);
    await replaceWallets(q, input.mint, wallets);
    for (const which of [7, 30]) await q.query(`insert into reports(mint, which, due_at) values ($1,$2,$3) on conflict do nothing`, [input.mint, which, new Date(launchedAtMs + which * 86_400_000)]);
    await q.query(`update bookings set status='launched' where id=$1`, [booking.id]);
    await q.query(`update seats set last_launch_at=$2, updated_at=now() where seat=$1`, [seat.seat, new Date(launchedAtMs)]);
    await emit(q, "launch_live", { seat: seat.seat, mint: input.mint, payload: { ticker, dev_pct: devPct, liquidity: input.liquidity, flags, auto: Boolean(input.auto), launch_cap_usd: null, slot_time: new Date(slotMs).toISOString().slice(11, 16) } });
    if (flags > 0) await emit(q, "launch_flagged", { seat: seat.seat, mint: input.mint, payload: { ticker, flags, checks: (precheck as { checks?: unknown[] }).checks ?? [] } });
  });
  const snap = await snapshotOne(ctx, input.mint).catch(() => null);
  return { mint: input.mint, ticker, seat: seat.seat, developer: seat.handle, launched_at: new Date(launchedAtMs).toISOString(), slot_at: new Date(slotMs).toISOString(), flags, precheck, first_snapshot: snap?.ok ? { price_usd: snap.priceUsd, holders: snap.holders } : null };
}

/** The developer completes or corrects the §6 disclosure (dev allocation, liquidity, insider wallets). */
export async function disclose(ctx: Ctx, input: { wallet: string; mint: string; devAllocationPct?: number; liquidity?: string; wallets?: DisclosedWallet[]; ticker?: string }) {
  const { rows: [l] } = await ctx.pool.query(`select l.mint, l.seat, l.ticker, l.status from launches l join developers d on d.id = l.developer_id where l.mint=$1 and d.deployer_wallet=$2`, [input.mint, input.wallet]);
  if (!l) throw new HttpError(404, "no such launch for this wallet");
  if (l.status === "banned" || l.status === "settled") throw new HttpError(409, "launch is closed");
  if (input.devAllocationPct !== undefined && (input.devAllocationPct < 0 || input.devAllocationPct > PAD.DEV_ALLOCATION_MAX_PCT)) throw new HttpError(400, `dev allocation must be 0–${PAD.DEV_ALLOCATION_MAX_PCT} %`);
  const wallets = input.wallets ? validateWallets(input.wallets) : null;
  await tx(ctx.pool, async (q) => {
    await q.query(`update launches set dev_allocation_pct = coalesce($2, dev_allocation_pct), liquidity = coalesce($3, liquidity), ticker = coalesce($4, ticker), precheck = coalesce(precheck,'{}'::jsonb) || '{"disclosed":true}'::jsonb where mint=$1`,
      [input.mint, input.devAllocationPct ?? null, input.liquidity ?? null, input.ticker ? TICKER(input.ticker) : null]);
    if (wallets) await replaceWallets(q, input.mint, wallets);
    await emit(q, "launch_disclosed", { seat: l.seat, mint: input.mint, payload: { ticker: input.ticker ? TICKER(input.ticker) : l.ticker, wallets: wallets?.length ?? null, dev_pct: input.devAllocationPct ?? null, liquidity: input.liquidity ?? null } });
  });
  return { ok: true, mint: input.mint, seat: l.seat };
}

function validateWallets(ws: DisclosedWallet[]): DisclosedWallet[] {
  if (!Array.isArray(ws) || ws.length > 20) throw new HttpError(400, "up to 20 disclosed wallets");
  const seen = new Set<string>();
  return ws.map((w) => {
    const address = String(w.address ?? ""), label = String(w.label ?? "").replace(/[<>"'`\\\u0000-\u001F]/g, "").slice(0, 24).trim() || "insider", pct = Number(w.pct);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new HttpError(400, `disclosed wallet ${address.slice(0, 8)}… is not a Solana address`);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, "wallet share must be 0–100 %");
    if (seen.has(address)) throw new HttpError(400, "duplicate disclosed wallet"); seen.add(address);
    return { label, address, pct: +pct.toFixed(2) };
  });
}
async function replaceWallets(q: Queryable, mint: string, wallets: DisclosedWallet[]) {
  await q.query(`delete from launch_wallets where mint=$1`, [mint]);
  for (const w of wallets) await q.query(`insert into launch_wallets(mint, label, address, pct) values ($1,$2,$3,$4)`, [mint, w.label, w.address, w.pct]);
}

export const seatLabel = (seat: number) => `Seat ${pad2(seat)}`;
