/**
 * Pre-flight for a devnet (or mainnet) run: does the environment describe a pad that can actually start?
 * Pure over an env map and a fetch, so it is testable without a network. `npm run devnet:check` runs it for real.
 */
import { readFileSync } from "node:fs";
import { PublicKey, Keypair } from "@solana/web3.js";

export type Level = "pass" | "warn" | "fail";
export interface Check { id: string; level: Level; detail: string }
export const GENESIS = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" } as const;
type Env = Record<string, string | undefined>;

export async function preflight(env: Env, f: typeof fetch = fetch, opts: { anchorProgramId?: string; cluster?: "devnet" | "mainnet-beta"; read?: (path: string) => string } = {}): Promise<Check[]> {
  const out: Check[] = []; const add = (id: string, level: Level, detail: string) => out.push({ id, level, detail });
  const want = opts.cluster ?? "devnet";
  const cluster = env.SOLANA_CLUSTER ?? "mainnet-beta";
  add("cluster", cluster === want ? "pass" : "fail", cluster === want ? `SOLANA_CLUSTER=${cluster}` : `SOLANA_CLUSTER is "${cluster}", this run expects "${want}"`);
  const scale = Number(env.AMOUNT_SCALE);
  if (want === "devnet") add("amounts", scale >= 1 ? "pass" : "warn", scale >= 1 ? `AMOUNT_SCALE=${scale} (slot fee ${3 / scale} SOL) — the program holds no money, so it needs no devnet build` : "AMOUNT_SCALE is not set: real 3 SOL slot fees need more faucet SOL than a rehearsal has");
  else add("amounts", env.AMOUNT_SCALE ? "fail" : "pass", env.AMOUNT_SCALE ? "AMOUNT_SCALE must not be set on mainnet (it is ignored there, remove it anyway)" : "real amounts");

  const rpc = env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://${want === "devnet" ? "devnet" : "mainnet"}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : "");
  const call = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const r = await f(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = (await r.json()) as { result?: T; error?: { message: string } }; if (j.error) throw new Error(j.error.message); return j.result as T;
  };
  let reachable = false;
  if (!rpc) add("rpc", "fail", "neither SOLANA_RPC_URL nor HELIUS_API_KEY is set");
  else {
    try {
      const g = await call<string>("getGenesisHash"); reachable = true;
      const right = want === "devnet" ? GENESIS.devnet : GENESIS.mainnet; const other = want === "devnet" ? GENESIS.mainnet : GENESIS.devnet;
      add("rpc", g === right ? "pass" : "fail", g === right ? `RPC reachable, genesis matches ${want}` : g === other ? `the RPC is on the WRONG network (expected ${want})` : `unknown genesis ${g.slice(0, 8)}…`);
    } catch (e) { add("rpc", "fail", `RPC unreachable: ${(e as Error).message}`); }
  }
  const key = (id: string, v: string | undefined, required = true): PublicKey | null => {
    if (!v) { add(id, required ? "fail" : "warn", `${id.toUpperCase()} is not set`); return null; }
    try { return new PublicKey(v); } catch { add(id, "fail", `${id.toUpperCase()} is not a valid address`); return null; }
  };
  const treasury = key("treasury", env.TREASURY_WALLET);
  if (treasury) add("treasury", "pass", `treasury ${treasury.toBase58().slice(0, 6)}… is a valid address${PublicKey.isOnCurve(treasury.toBytes()) ? "" : " (off-curve: a PDA or multisig vault — fine if intended)"}`);
  const program = key("program", env.PROGRAM_ID);
  if (program) {
    if (opts.anchorProgramId && opts.anchorProgramId !== program.toBase58()) add("program-id", "warn", `PROGRAM_ID differs from Anchor.toml (${opts.anchorProgramId.slice(0, 8)}…) — run \`anchor keys sync\` and redeploy, or fix .env`);
    if (reachable) {
      try { const a = await call<{ value: { executable: boolean } | null }>("getAccountInfo", [program.toBase58(), { encoding: "base64" }]); add("program", a.value?.executable ? "pass" : "fail", a.value?.executable ? "program is deployed and executable" : a.value ? "that address exists but is not a program" : "the program is not deployed on this cluster yet (anchor deploy)"); }
      catch (e) { add("program", "fail", `could not read the program: ${(e as Error).message}`); }
    }
  }
  if (!env.SCORE_ORACLE_KEYPAIR) add("oracle", "warn", "SCORE_ORACLE_KEYPAIR not set: scores are computed but not written on chain");
  else {
    try {
      const raw = env.SCORE_ORACLE_KEYPAIR.trim().startsWith("[") ? env.SCORE_ORACLE_KEYPAIR : (opts.read ?? ((p: string) => readFileSync(p, "utf8")))(env.SCORE_ORACLE_KEYPAIR);
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
      if (reachable) { const b = (await call<{ value: number }>("getBalance", [kp.publicKey.toBase58()])).value; add("oracle", b >= 50_000_000 ? "pass" : "warn", `oracle ${kp.publicKey.toBase58().slice(0, 6)}… holds ${(b / 1e9).toFixed(3)} SOL${b >= 50_000_000 ? "" : " — fund it (it pays transaction fees)"}`); }
      else add("oracle", "pass", `oracle keypair parses (${kp.publicKey.toBase58().slice(0, 6)}…)`);
    } catch { add("oracle", "fail", "SCORE_ORACLE_KEYPAIR must be the path of a keypair file (a 64-byte JSON array) — this one cannot be read or parsed"); }
  }
  const secret = (id: string, v: string | undefined, min = 16) => add(id, v && v.length >= min ? "pass" : "fail", v && v.length >= min ? `${id} set` : `${id} must be set (≥ ${min} characters)`);
  secret("KEY_PEPPER", env.KEY_PEPPER); secret("HELIUS_WEBHOOK_SECRET", env.HELIUS_WEBHOOK_SECRET);
  add("DATABASE_URL", env.DATABASE_URL ? "pass" : "fail", env.DATABASE_URL ? "database configured" : "DATABASE_URL is not set");
  add("vapid", env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? "pass" : "warn", env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? "VAPID keys set (api and bot need the same pair)" : "VAPID keys missing: browser notifications stay off");
  add("telegram", env.TELEGRAM_BOT_TOKEN ? "pass" : "warn", env.TELEGRAM_BOT_TOKEN ? "bot token set" : "TELEGRAM_BOT_TOKEN missing: no channel posts or DMs");
  add("site", /^https:\/\//.test(env.PUBLIC_SITE_URL ?? "") ? "pass" : "warn", /^https:\/\//.test(env.PUBLIC_SITE_URL ?? "") ? `PUBLIC_SITE_URL ${env.PUBLIC_SITE_URL}` : "PUBLIC_SITE_URL should be the https address of the site (push links and share cards use it)");
  const anchor = Date.parse(env.SEASON_ANCHOR_UTC ?? "");
  add("season", Number.isFinite(anchor) ? "pass" : "warn", Number.isFinite(anchor) ? `season 1 starts ${new Date(anchor).toISOString()}` : "SEASON_ANCHOR_UTC not set: the default anchor is used");
  return out;
}

export const summary = (checks: Check[]) => ({ fail: checks.filter((c) => c.level === "fail").length, warn: checks.filter((c) => c.level === "warn").length, pass: checks.filter((c) => c.level === "pass").length });
