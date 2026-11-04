/**
 * The four pre-checks (§2, §6) against on-chain history.
 *
 *   dev_vest_sell       — did the deployer wallet move tokens of its own mint out inside the 30-day vest?
 *   first_block_bundle  — were there buyers in the creation slot (or the next one) that share a funding
 *                         source with the deployer?
 *   liquidity           — is the LP token burned or in a known locker?
 *   deployer_cluster    — does the deployer share a funding parent with other deployers in our index?
 *
 * Each check returns pass / flag / unknown with human-readable detail and evidence (signatures or
 * addresses) so the committee can verify every line by hand. "unknown" is never counted as a flag.
 */
import { Helius, KNOWN, type ParsedTx } from "./helius.js";
import type { CheckResult, ScanReport } from "@twenty/shared";
import { PAD } from "@twenty/shared";

export interface ScanContext {
  helius: Helius;
  /** deployer wallets of launches already in the index, keyed by funding parent — used by deployer_cluster */
  knownFundingParents?: Map<string, string[]>;
  nowMs?: number;
  log?: (msg: string) => void;
}

const DAY = 86_400_000;
const isAmm = (tx: ParsedTx) => KNOWN.AMM_PROGRAMS.has(tx.source) || Boolean(tx.events?.swap) || tx.type === "SWAP";

/** First inbound SOL transfer to a wallet = its funding parent (exchange hot wallet, another deployer, …). */
export async function fundingParent(ctx: ScanContext, wallet: string): Promise<{ parent: string; signature: string } | null> {
  let oldest: ParsedTx | null = null;
  for await (const tx of ctx.helius.walk(wallet, 20)) {
    const inbound = tx.nativeTransfers.find((t) => t.toUserAccount === wallet && t.amount > 0);
    if (inbound) oldest = tx; // history is newest-first, so the last inbound we see is the oldest
  }
  if (!oldest) return null;
  const t = oldest.nativeTransfers.find((x) => x.toUserAccount === wallet)!;
  return { parent: t.fromUserAccount, signature: oldest.signature };
}

/** Find the mint-creation transaction and the slot it happened in. */
export async function creation(ctx: ScanContext, mint: string): Promise<ParsedTx | null> {
  let first: ParsedTx | null = null;
  for await (const tx of ctx.helius.walk(mint, 40)) first = tx; // oldest page last
  return first;
}

export async function checkDevVestSell(ctx: ScanContext, deployer: string, mint: string, launchedAtMs: number): Promise<CheckResult> {
  const id = "dev_vest_sell"; const evidence: string[] = []; let sold = 0; let decimals = 6;
  try {
    const asset = await ctx.helius.asset(mint); decimals = asset.token_info?.decimals ?? 6;
    const vestEnd = launchedAtMs + PAD.VEST_DAYS * DAY;
    for await (const tx of ctx.helius.walk(deployer, 30, (t) => t.timestamp * 1000 < launchedAtMs)) {
      const ts = tx.timestamp * 1000; if (ts < launchedAtMs || ts > vestEnd) continue;
      const out = tx.tokenTransfers.filter((t) => t.mint === mint && t.fromUserAccount === deployer && t.toUserAccount !== deployer);
      if (!out.length) continue;
      const amt = out.reduce((a, t) => a + t.tokenAmount, 0); sold += amt;
      evidence.push(`${tx.signature} · ${isAmm(tx) ? "sold via " + (KNOWN.AMM_PROGRAMS.get(tx.source) ?? "AMM") : "transferred out"} · ${amt.toLocaleString()} on day ${Math.floor((ts - launchedAtMs) / DAY)}`);
    }
    if (!evidence.length) return { id, result: "pass", detail: "no outflow from the deployer wallet inside the 30-day vest", evidence };
    const supply = await ctx.helius.supply(mint).catch(() => 0);
    const pct = supply ? (sold / supply) * 100 : 0;
    return { id, result: "flag", detail: `${evidence.length} outflow${evidence.length > 1 ? "s" : ""} inside the vest · ${pct ? pct.toFixed(2) + "% of supply" : sold.toLocaleString() + " tokens"}`, evidence };
  } catch (e) { return { id, result: "unknown", detail: `could not read history: ${(e as Error).message}`, evidence }; }
}

export async function checkFirstBlockBundle(ctx: ScanContext, deployer: string, mint: string): Promise<CheckResult> {
  const id = "first_block_bundle"; const evidence: string[] = [];
  try {
    const c = await creation(ctx, mint); if (!c) return { id, result: "unknown", detail: "creation transaction not found", evidence };
    // buyers in the creation slot and the next slot
    const buyers = new Set<string>();
    for await (const tx of ctx.helius.walk(mint, 40, (t) => t.slot < c.slot)) {
      if (tx.slot > c.slot + 1) continue;
      for (const t of tx.tokenTransfers) if (t.mint === mint && t.toUserAccount && t.toUserAccount !== deployer) buyers.add(t.toUserAccount);
    }
    if (!buyers.size) return { id, result: "pass", detail: "no buyers in the creation block", evidence };
    const devParent = await fundingParent(ctx, deployer);
    const linked: string[] = [];
    for (const b of [...buyers].slice(0, 25)) {
      const p = await fundingParent(ctx, b).catch(() => null);
      if (p && (p.parent === deployer || (devParent && p.parent === devParent.parent))) { linked.push(b); evidence.push(`${b} funded by ${p.parent === deployer ? "the deployer" : "the deployer's funding parent"} · ${p.signature}`); }
    }
    if (!linked.length) return { id, result: "pass", detail: `${buyers.size} first-block buyer${buyers.size > 1 ? "s" : ""}, none funding-linked to the deployer`, evidence };
    return { id, result: "flag", detail: `${linked.length} of ${buyers.size} first-block buyers share a funding source with the deployer`, evidence };
  } catch (e) { return { id, result: "unknown", detail: `could not read creation block: ${(e as Error).message}`, evidence }; }
}

export async function checkLiquidity(ctx: ScanContext, mint: string): Promise<CheckResult> {
  const id = "liquidity"; const evidence: string[] = [];
  try {
    // Find the pool: the largest token account whose owner is an AMM program.
    const largest = await ctx.helius.largestAccounts(mint);
    let lpMint: string | null = null; let venue = "";
    for (const acc of largest.value) {
      const info = await ctx.helius.rpcCall<{ value: { data: { parsed: { info: { owner: string } } } } }>("getAccountInfo", [acc.address, { encoding: "jsonParsed" }]).catch(() => null);
      const owner = info?.value?.data?.parsed?.info?.owner; if (!owner) continue;
      if (KNOWN.AMM_PROGRAMS.has(owner)) { venue = KNOWN.AMM_PROGRAMS.get(owner)!; evidence.push(`pool token account ${acc.address} owned by ${venue}`); }
    }
    if (!venue) return { id, result: "unknown", detail: "no AMM pool found among the largest holders", evidence };
    if (venue.startsWith("pump.fun")) return { id, result: "pass", detail: `${venue} bonding curve · liquidity is program-owned, no LP token to pull`, evidence };
    // For Raydium/Orca/Meteora: look for the LP mint in the pool creation tx of the deployer, then check where LP tokens went.
    for await (const tx of ctx.helius.walk(mint, 40)) {
      const lp = tx.tokenTransfers.find((t) => t.mint !== mint && t.toUserAccount && (t.toUserAccount === KNOWN.INCINERATOR || KNOWN.LOCKERS.has(t.toUserAccount)));
      if (lp) { lpMint = lp.mint; const dest = lp.toUserAccount === KNOWN.INCINERATOR ? "burned" : `locked in ${KNOWN.LOCKERS.get(lp.toUserAccount!)}`; evidence.push(`${tx.signature} · LP ${lp.mint} ${dest}`); return { id, result: "pass", detail: `${venue} · LP ${dest}`, evidence }; }
    }
    return { id, result: lpMint ? "flag" : "flag", detail: `${venue} pool found but no LP burn or lock seen in the mint's history`, evidence };
  } catch (e) { return { id, result: "unknown", detail: `could not resolve liquidity: ${(e as Error).message}`, evidence }; }
}

export async function checkDeployerCluster(ctx: ScanContext, deployer: string): Promise<CheckResult> {
  const id = "deployer_cluster"; const evidence: string[] = [];
  try {
    const p = await fundingParent(ctx, deployer);
    if (!p) return { id, result: "unknown", detail: "no inbound SOL transfer found", evidence };
    evidence.push(`funded by ${p.parent} · ${p.signature}`);
    const siblings = (ctx.knownFundingParents?.get(p.parent) ?? []).filter((w) => w !== deployer);
    if (!siblings.length) return { id, result: "pass", detail: "single deployer under this funding source in the index", evidence };
    siblings.forEach((s) => evidence.push(`sibling deployer ${s}`));
    return { id, result: "flag", detail: `shares a funding source with ${siblings.length} other deployer${siblings.length > 1 ? "s" : ""} in the index`, evidence };
  } catch (e) { return { id, result: "unknown", detail: `could not trace funding: ${(e as Error).message}`, evidence }; }
}

/** Pre-check score: 100 − 22 per flag − 6 per pad warning; unknowns do not count. Same formula as the site. */
export function preScore(checks: CheckResult[], warnings = 0): number {
  const flags = checks.filter((c) => c.result === "flag").length;
  return Math.max(0, 100 - 22 * flags - 6 * warnings);
}
export function verdict(flags: number): string {
  return flags === 0 ? "Would pass the committee's first pass" : flags === 1 ? "One flag to explain at the interview" : "Would not reach the interview as it stands";
}

/** Scan a launch: deployer + mint pair. */
export async function scanLaunch(ctx: ScanContext, deployer: string, mint: string, launchedAtMs: number): Promise<ScanReport> {
  const checks = await Promise.all([
    checkDevVestSell(ctx, deployer, mint, launchedAtMs),
    checkFirstBlockBundle(ctx, deployer, mint),
    checkLiquidity(ctx, mint),
    checkDeployerCluster(ctx, deployer),
  ]);
  const flags = checks.filter((c) => c.result === "flag").length;
  return { address: mint, kind: "mint", checks, flags, score: preScore(checks), verdict: verdict(flags), scanned_at: new Date(ctx.nowMs ?? Date.now()).toISOString(), engine: "live" };
}

/** Scan a deployer wallet: find the mints it created (first mint tx per mint), scan each, aggregate the worst result per check. */
export async function scanDeployer(ctx: ScanContext, deployer: string, maxMints = 5): Promise<ScanReport> {
  const mints = new Map<string, number>();
  for await (const tx of ctx.helius.walk(deployer, 30)) {
    if (tx.type === "TOKEN_MINT" || tx.type === "CREATE" || tx.source === "PUMP_FUN") {
      for (const t of tx.tokenTransfers) if (t.toUserAccount === deployer && !mints.has(t.mint)) mints.set(t.mint, tx.timestamp * 1000);
    }
  }
  const targets = [...mints].slice(0, maxMints);
  if (!targets.length) {
    const cluster = await checkDeployerCluster(ctx, deployer);
    const checks: CheckResult[] = [
      { id: "dev_vest_sell", result: "unknown", detail: "no launches found for this wallet", evidence: [] },
      { id: "first_block_bundle", result: "unknown", detail: "no launches found for this wallet", evidence: [] },
      { id: "liquidity", result: "unknown", detail: "no launches found for this wallet", evidence: [] },
      cluster,
    ];
    const flags = checks.filter((c) => c.result === "flag").length;
    return { address: deployer, kind: "wallet", checks, flags, score: preScore(checks), verdict: verdict(flags), scanned_at: new Date().toISOString(), engine: "live" };
  }
  const reports = await Promise.all(targets.map(([mint, ts]) => scanLaunch(ctx, deployer, mint, ts)));
  const worst = (idx: number): CheckResult => reports.map((r) => r.checks[idx]).sort((a, b) => rank(b) - rank(a))[0];
  const checks = [0, 1, 2, 3].map(worst).map((c) => ({ ...c, detail: `${c.detail} · across ${targets.length} launch${targets.length > 1 ? "es" : ""}` }));
  const flags = checks.filter((c) => c.result === "flag").length;
  return { address: deployer, kind: "wallet", checks, flags, score: preScore(checks), verdict: verdict(flags), scanned_at: new Date().toISOString(), engine: "live" };
}
const rank = (c: CheckResult) => (c.result === "flag" ? 2 : c.result === "unknown" ? 1 : 0);
