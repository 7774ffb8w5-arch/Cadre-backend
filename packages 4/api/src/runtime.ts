/** Builds the shared Ctx from the environment (server, runner and one-off scripts all use this). */
import type { Db } from "@twenty/shared";
import { Helius } from "@twenty/scanner";
import type { Ctx } from "./ctx.js";
import { makeOracle, disabledOracle } from "./oracle.js";
import { configureVapid, sendPush } from "@twenty/shared";
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) { try { configureVapid(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY, process.env.VAPID_SUBJECT || undefined); } catch (e) { console.error("VAPID keys invalid:", (e as Error).message); } }

const quiet = { info() {}, warn() {}, error() {} };

export function makeCtx(o: { pool: Db; helius?: Helius; log?: Ctx["log"]; fetch?: typeof fetch; now?: () => number; anchorMs?: number; oracle?: Ctx["oracle"]; treasury?: string | null; sendPush?: Ctx["sendPush"] }): Ctx {
  const log = o.log ?? quiet;
  return {
    pool: o.pool,
    helius: o.helius ?? new Helius(process.env.HELIUS_API_KEY ?? "", (process.env.SOLANA_CLUSTER as "mainnet-beta" | "devnet") ?? "mainnet-beta"),
    anchorMs: o.anchorMs ?? Date.parse(process.env.SEASON_ANCHOR_UTC ?? "2026-10-12T00:00:00Z"),
    oracle: o.oracle ?? (process.env.PROGRAM_ID && process.env.SCORE_ORACLE_KEYPAIR ? makeOracle({ log: (x, m) => log.info(x, m) }) : disabledOracle),
    treasury: o.treasury === undefined ? (process.env.TREASURY_WALLET ?? null) : o.treasury,
    now: o.now ?? (() => Date.now()),
    log, fetch: o.fetch ?? fetch, sendPush: o.sendPush ?? sendPush,
  };
}
