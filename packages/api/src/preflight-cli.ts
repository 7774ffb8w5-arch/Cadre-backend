/** `npm run devnet:check [-- --env .env.devnet] [--cluster mainnet-beta]` — prints the checks, exits 1 if any fails. */
import { readFileSync, existsSync } from "node:fs";
import { preflight, summary } from "./preflight.js";

const arg = (n: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
const env: Record<string, string | undefined> = { ...process.env };
const file = arg("env"); if (file) {
  if (!existsSync(file)) { console.error(`env file not found: ${file}`); process.exit(2); }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); }
}
let anchorProgramId: string | undefined;
for (const p of ["program/Anchor.toml", "../../program/Anchor.toml"]) if (existsSync(p)) { const m = /\[programs\.\w+\][^[]*?twenty\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(readFileSync(p, "utf8")); if (m) { anchorProgramId = m[1]; break; } }
const cluster = (arg("cluster") as "devnet" | "mainnet-beta" | undefined) ?? "devnet";
const checks = await preflight(env, fetch, { cluster, anchorProgramId });
const icon = { pass: "✓", warn: "!", fail: "✗" } as const;
for (const c of checks) console.log(`${icon[c.level]} ${c.id.padEnd(22)} ${c.detail}`);
const s = summary(checks); console.log(`\n${s.pass} ok · ${s.warn} warnings · ${s.fail} failures`); process.exit(s.fail ? 1 : 0);
