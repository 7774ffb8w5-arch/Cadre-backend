/**
 * Deployer index — the data moat behind `deployer_cluster`.
 * Every token creation on the big launchpads is recorded with its deployer; funding parents are resolved
 * in the background. The more launches indexed, the better the cluster check gets, and nobody else has it.
 *
 *   webhook:  Helius enhanced webhook → POST /v1/webhooks/helius (type CREATE / TOKEN_MINT) → ingest()
 *   backfill: walk the launchpad program's history page by page → ingest()
 *   resolve:  fill funding_parent for rows that lack one, N per run, respecting the RPC budget
 */
import type { Db } from "@twenty/shared";
import { Helius, type ParsedTx, RateLimited } from "./helius.js";
import { fundingParent } from "./checks.js";

export const LAUNCHPADS = {
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
};

export interface Creation { mint: string; deployer: string; createdAt: Date; signature: string; venue: string }

/** Pull creations out of parsed transactions. */
export function creationsOf(txs: ParsedTx[]): Creation[] {
  const out: Creation[] = [];
  for (const tx of txs) {
    const isCreate = tx.type === "CREATE" || tx.type === "TOKEN_MINT" || (tx.source === "PUMP_FUN" && tx.tokenTransfers.some((t) => t.fromUserAccount === null));
    if (!isCreate) continue;
    const minted = tx.tokenTransfers.find((t) => t.toUserAccount === tx.feePayer) ?? tx.tokenTransfers[0];
    if (!minted) continue;
    out.push({ mint: minted.mint, deployer: tx.feePayer, createdAt: new Date(tx.timestamp * 1000), signature: tx.signature, venue: tx.source || "unknown" });
  }
  return out;
}

export async function ingest(pool: Db, creations: Creation[]): Promise<number> {
  let n = 0;
  for (const c of creations) {
    const r = await pool.query(`insert into deployer_index(mint, deployer, created_at, signature, venue) values ($1,$2,$3,$4,$5) on conflict (mint) do nothing`, [c.mint, c.deployer, c.createdAt, c.signature, c.venue]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Backfill from a launchpad program's own history. `pages` × 100 transactions per run. */
export async function backfill(helius: Helius, pool: Db, program = LAUNCHPADS.PUMP_FUN, pages = 20, before?: string): Promise<{ ingested: number; before?: string }> {
  let ingested = 0; let cursor = before;
  for (let p = 0; p < pages; p++) {
    let page: ParsedTx[];
    try { page = await helius.transactions(program, { limit: 100, before: cursor, type: "CREATE" }); } catch (e) { if (e instanceof RateLimited) { await sleep(2000); p--; continue; } throw e; }
    if (!page.length) break;
    ingested += await ingest(pool, creationsOf(page));
    cursor = page[page.length - 1].signature;
  }
  return { ingested, before: cursor };
}

/** Resolve funding parents for deployers that lack one. Each resolution costs up to 20 RPC pages, so keep `n` small per run. */
export async function resolveParents(helius: Helius, pool: Db, n = 25): Promise<number> {
  const { rows } = await pool.query<{ deployer: string }>(`select deployer from deployer_index where funding_parent is null and parent_attempts < 3 group by deployer order by max(created_at) desc limit $1`, [n]);
  let done = 0;
  for (const { deployer } of rows) {
    try {
      const p = await fundingParent({ helius }, deployer);
      await pool.query(`update deployer_index set funding_parent=$2, funding_signature=$3, parent_attempts = parent_attempts + 1, parent_resolved_at = now() where deployer=$1`, [deployer, p?.parent ?? null, p?.signature ?? null]);
      if (p) done++;
    } catch (e) {
      if (e instanceof RateLimited) { await sleep(3000); continue; }
      await pool.query(`update deployer_index set parent_attempts = parent_attempts + 1 where deployer=$1`, [deployer]);
    }
  }
  return done;
}

/** The map `deployer_cluster` consumes: funding parent → deployers (excluding CEX hot wallets with > 200 children, which fund everyone). */
export async function knownFundingParents(pool: Db): Promise<Map<string, string[]>> {
  const { rows } = await pool.query<{ funding_parent: string; deployers: string[] }>(`select funding_parent, array_agg(distinct deployer) as deployers from deployer_index where funding_parent is not null group by funding_parent having count(distinct deployer) between 2 and 200`);
  return new Map(rows.map((r) => [r.funding_parent, r.deployers]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
