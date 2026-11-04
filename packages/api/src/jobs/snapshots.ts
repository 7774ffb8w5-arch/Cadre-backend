/**
 * Market + holder snapshots (§4 inputs). Every 6 h for every launch that is live or open, every 30 min in a
 * launch's first 48 h. Each pass:
 *   1. quotes price / mcap / liquidity (market.ts) and counts holders (Helius DAS)
 *   2. writes `launch_snapshots`; the first snapshot after launch fixes `launch_cap_usd`
 *   3. diffs holder balances against `holder_positions` and books buys at this snapshot's price → cost basis
 *      (average-cost method; sells scale the cost down pro rata). This is what the day-30 holder outcome reads.
 */
import type { Queryable } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { quote } from "../market.js";

export interface SnapshotResult { mint: string; ok: boolean; priceUsd?: number; holders?: number; error?: string }

export async function snapshotOne(ctx: Ctx, mint: string, opts: { holders?: boolean } = {}): Promise<SnapshotResult> {
  const { rows: [l] } = await ctx.pool.query(`select mint, supply, decimals, launch_cap_usd, developer_id, status from launches where mint=$1`, [mint]);
  if (!l) return { mint, ok: false, error: "unknown launch" };
  const q = await quote(ctx.fetch, mint);
  if (!q) return { mint, ok: false, error: "no market data yet" };
  let supply = l.supply ? Number(l.supply) : null, decimals = l.decimals ?? null;
  if (supply === null || decimals === null) {
    const asset = await ctx.helius.asset(mint).catch(() => null);
    if (asset?.token_info) { supply = asset.token_info.supply; decimals = asset.token_info.decimals; await ctx.pool.query(`update launches set supply=$2, decimals=$3 where mint=$1`, [mint, String(supply), decimals]); }
  }
  const ui = (raw: number | bigint) => (decimals === null ? Number(raw) : Number(raw) / 10 ** decimals);
  const mcap = q.mcapUsd ?? (supply !== null && decimals !== null ? q.priceUsd * ui(supply) : 0);
  let holderCount: number | null = null;
  if (opts.holders !== false) {
    try {
      const holders = await ctx.helius.holders(mint);
      holderCount = holders.filter((h) => h.amount > 0n).length;
      await applyPositions(ctx.pool, mint, holders, q.priceUsd, decimals ?? 0);
    } catch (e) { ctx.log.warn({ mint, err: (e as Error).message }, "holder snapshot failed"); }
  }
  if (holderCount === null) { const { rows: [p] } = await ctx.pool.query(`select holders from launch_snapshots where mint=$1 order by at desc limit 1`, [mint]); holderCount = Number(p?.holders ?? 0); }
  const at = new Date(ctx.now());
  await ctx.pool.query(`insert into launch_snapshots(mint, at, mcap_usd, holders, price_usd, liquidity_usd) values ($1,$2,$3,$4,$5,$6) on conflict (mint, at) do nothing`, [mint, at, mcap.toFixed(2), holderCount, q.priceUsd.toFixed(12), q.liquidityUsd?.toFixed(2) ?? null]);
  if (!l.launch_cap_usd && mcap > 0) await ctx.pool.query(`update launches set launch_cap_usd=$2 where mint=$1 and launch_cap_usd is null`, [mint, mcap.toFixed(2)]);
  return { mint, ok: true, priceUsd: q.priceUsd, holders: holderCount ?? 0 };
}

/** Average-cost positions from balance deltas. Exported for the tests. */
export async function applyPositions(q: Queryable, mint: string, holders: { owner: string; amount: bigint }[], priceUsd: number, decimals: number) {
  const { rows: prev } = await q.query<{ owner: string; tokens: string; cost_usd: string }>(`select owner, tokens, cost_usd from holder_positions where mint=$1`, [mint]);
  const before = new Map(prev.map((p) => [p.owner, { tokens: BigInt(p.tokens), cost: Number(p.cost_usd) }]));
  const seen = new Set<string>();
  for (const h of holders) {
    seen.add(h.owner);
    const old = before.get(h.owner); const was = old?.tokens ?? 0n; const now = h.amount;
    if (old && was === now) continue;
    let cost = old?.cost ?? 0;
    if (now > was) cost += (Number(now - was) / 10 ** decimals) * priceUsd;                       // buy at this snapshot's price
    else if (was > 0n) cost = now === 0n ? 0 : cost * (Number(now) / Number(was));              // sell: average cost stays, basis shrinks pro rata
    await q.query(`insert into holder_positions(mint, owner, tokens, cost_usd, first_seen) values ($1,$2,$3,$4,now())
      on conflict (mint, owner) do update set tokens = excluded.tokens, cost_usd = excluded.cost_usd, updated_at = now()`, [mint, h.owner, now.toString(), cost.toFixed(6)]);
  }
  for (const [owner, o] of before) if (!seen.has(owner) && o.tokens > 0n) await q.query(`update holder_positions set tokens = 0, cost_usd = 0, updated_at = now() where mint=$1 and owner=$2`, [mint, owner]);
}

/** One pass over everything that needs a snapshot now. */
export async function runSnapshots(ctx: Ctx, opts: { fresh?: boolean } = {}): Promise<SnapshotResult[]> {
  const { rows } = await ctx.pool.query<{ mint: string }>(opts.fresh
    ? `select mint from launches where status in ('live','open') and launched_at > now() - interval '48 hours' order by launched_at desc`
    : `select mint from launches where status in ('live','open') order by launched_at desc`);
  const out: SnapshotResult[] = [];
  for (const { mint } of rows) { out.push(await snapshotOne(ctx, mint).catch((e) => ({ mint, ok: false, error: (e as Error).message }))); }
  return out;
}
