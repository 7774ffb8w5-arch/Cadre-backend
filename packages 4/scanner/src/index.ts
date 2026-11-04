#!/usr/bin/env node
/** CLI: `npm run scan -- <wallet-or-mint> [--mint <mint> --deployer <wallet> --launched 2026-10-30T20:00:00Z]` */
import { Helius } from "./helius.js";
import { scanDeployer, scanLaunch } from "./checks.js";
export * from "./helius.js";
export * from "./checks.js";
export * from "./indexer.js";

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) { console.log("usage: scan <address> | scan --deployer <wallet> --mint <mint> --launched <iso>"); return; }
  const helius = new Helius(process.env.HELIUS_API_KEY ?? "", (process.env.SOLANA_CLUSTER as "mainnet-beta" | "devnet") ?? "mainnet-beta");
  const ctx = { helius, log: (m: string) => console.error(m) };
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const report = get("--mint")
    ? await scanLaunch(ctx, get("--deployer")!, get("--mint")!, Date.parse(get("--launched") ?? new Date().toISOString()))
    : await scanDeployer(ctx, args[0]);
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
