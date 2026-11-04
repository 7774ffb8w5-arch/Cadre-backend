/**
 * Fixture-based tests for the four checks. A FakeHelius serves hand-built ParsedTx histories so every
 * branch of checks.ts is exercised without an API key. Run: npm -w @twenty/scanner test
 */
import assert from "node:assert/strict";
import type { Helius, ParsedTx } from "../src/helius.js";
import { KNOWN } from "../src/helius.js";
import { checkDevVestSell, checkFirstBlockBundle, checkLiquidity, checkDeployerCluster, scanLaunch, preScore } from "../src/checks.js";

const DAY = 86_400;
const DEV = "DEVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const MINT = "MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const LP = "LPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const CEX = "CEXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const BUYER = "BUYERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const POOL = "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const T0 = 1_760_000_000; // launch time (s)

const tx = (p: Partial<ParsedTx> & { signature: string }): ParsedTx => ({ slot: 1000, timestamp: T0, type: "UNKNOWN", source: "SYSTEM_PROGRAM", fee: 5000, feePayer: DEV, nativeTransfers: [], tokenTransfers: [], ...p });

/** Histories are newest-first, like the real API. */
class FakeHelius {
  constructor(private hist: Record<string, ParsedTx[]>, private owners: Record<string, string> = {}, private supplyN = 1_000_000) {}
  async transactions(address: string, opts: { limit?: number; before?: string } = {}) {
    const all = this.hist[address] ?? []; const start = opts.before ? all.findIndex((t) => t.signature === opts.before) + 1 : 0;
    return all.slice(start, start + (opts.limit ?? 100));
  }
  async *walk(address: string, maxPages = 10, until?: (t: ParsedTx) => boolean) { let before: string | undefined; for (let p = 0; p < maxPages; p++) { const page = await this.transactions(address, { before }); if (!page.length) return; for (const t of page) { yield t; if (until && until(t)) return; } before = page[page.length - 1].signature; } }
  async asset() { return { id: MINT, interface: "FungibleToken", token_info: { supply: this.supplyN, decimals: 6 } }; }
  async largestAccounts() { return { value: Object.keys(this.owners).map((address) => ({ address, amount: "1", decimals: 6, uiAmount: 1 })) }; }
  async supply() { return this.supplyN; }
  async rpcCall(method: string, params: unknown[]) { if (method === "getAccountInfo") { const acc = (params as string[])[0]; return { value: { data: { parsed: { info: { owner: this.owners[acc] } } } } }; } throw new Error("unexpected " + method); }
  async holders() { return []; }
}
const ctxOf = (h: FakeHelius, knownFundingParents?: Map<string, string[]>) => ({ helius: h as unknown as Helius, knownFundingParents });

(async () => {
  // ── dev_vest_sell ──
  const devSell = new FakeHelius({ [DEV]: [
    tx({ signature: "s3", timestamp: T0 + 12 * DAY, source: RAYDIUM, type: "SWAP", tokenTransfers: [{ mint: MINT, fromUserAccount: DEV, toUserAccount: POOL, fromTokenAccount: "a", toTokenAccount: "b", tokenAmount: 31_000 }] }),
    tx({ signature: "s2", timestamp: T0 + 1 * DAY, tokenTransfers: [{ mint: MINT, fromUserAccount: BUYER, toUserAccount: DEV, fromTokenAccount: "a", toTokenAccount: "b", tokenAmount: 10 }] }),
    tx({ signature: "s1", timestamp: T0 - 5 * DAY, nativeTransfers: [{ fromUserAccount: CEX, toUserAccount: DEV, amount: 1e9 }] }),
  ] });
  let r = await checkDevVestSell(ctxOf(devSell), DEV, MINT, T0 * 1000);
  assert.equal(r.result, "flag", "dev sell inside vest is a flag"); assert.match(r.detail, /3\.10% of supply/); assert.equal(r.evidence.length, 1);
  const devClean = new FakeHelius({ [DEV]: [tx({ signature: "s9", timestamp: T0 + 40 * DAY, source: RAYDIUM, type: "SWAP", tokenTransfers: [{ mint: MINT, fromUserAccount: DEV, toUserAccount: POOL, fromTokenAccount: "a", toTokenAccount: "b", tokenAmount: 1000 }] })] });
  r = await checkDevVestSell(ctxOf(devClean), DEV, MINT, T0 * 1000);
  assert.equal(r.result, "pass", "selling after the vest is not a flag");

  // ── first_block_bundle ──
  const creation = tx({ signature: "c0", slot: 500, timestamp: T0, type: "CREATE", source: "PUMP_FUN", tokenTransfers: [{ mint: MINT, fromUserAccount: null, toUserAccount: DEV, fromTokenAccount: null, toTokenAccount: "d", tokenAmount: 50_000 }] });
  const bundled = new FakeHelius({
    [MINT]: [tx({ signature: "b1", slot: 500, timestamp: T0, tokenTransfers: [{ mint: MINT, fromUserAccount: POOL, toUserAccount: BUYER, fromTokenAccount: "p", toTokenAccount: "q", tokenAmount: 20_000 }] }), creation],
    [BUYER]: [tx({ signature: "f1", timestamp: T0 - 60, nativeTransfers: [{ fromUserAccount: DEV, toUserAccount: BUYER, amount: 5e8 }] })],
    [DEV]: [tx({ signature: "f0", timestamp: T0 - 5 * DAY, nativeTransfers: [{ fromUserAccount: CEX, toUserAccount: DEV, amount: 1e9 }] })],
  });
  r = await checkFirstBlockBundle(ctxOf(bundled), DEV, MINT);
  assert.equal(r.result, "flag", "first-block buyer funded by the deployer is a flag"); assert.match(r.detail, /1 of 1/);
  const organic = new FakeHelius({
    [MINT]: [tx({ signature: "b1", slot: 500, timestamp: T0, tokenTransfers: [{ mint: MINT, fromUserAccount: POOL, toUserAccount: BUYER, fromTokenAccount: "p", toTokenAccount: "q", tokenAmount: 20_000 }] }), creation],
    [BUYER]: [tx({ signature: "f1", timestamp: T0 - 60, nativeTransfers: [{ fromUserAccount: "OTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1", toUserAccount: BUYER, amount: 5e8 }] })],
    [DEV]: [tx({ signature: "f0", timestamp: T0 - 5 * DAY, nativeTransfers: [{ fromUserAccount: CEX, toUserAccount: DEV, amount: 1e9 }] })],
  });
  r = await checkFirstBlockBundle(ctxOf(organic), DEV, MINT);
  assert.equal(r.result, "pass", "independently funded first-block buyer passes");

  // ── liquidity ──
  const pump = new FakeHelius({ [MINT]: [creation] }, { [POOL]: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" });
  r = await checkLiquidity(ctxOf(pump), MINT); assert.equal(r.result, "pass"); assert.match(r.detail, /bonding curve/);
  const burned = new FakeHelius({ [MINT]: [tx({ signature: "lp1", timestamp: T0 + 60, tokenTransfers: [{ mint: LP, fromUserAccount: DEV, toUserAccount: KNOWN.INCINERATOR, fromTokenAccount: "x", toTokenAccount: "y", tokenAmount: 1 }] }), creation] }, { [POOL]: RAYDIUM });
  r = await checkLiquidity(ctxOf(burned), MINT); assert.equal(r.result, "pass"); assert.match(r.detail, /burned/);
  const unlocked = new FakeHelius({ [MINT]: [creation] }, { [POOL]: RAYDIUM });
  r = await checkLiquidity(ctxOf(unlocked), MINT); assert.equal(r.result, "flag", "AMM pool without burn or lock is a flag");
  const noPool = new FakeHelius({ [MINT]: [creation] }, {});
  r = await checkLiquidity(ctxOf(noPool), MINT); assert.equal(r.result, "unknown", "no pool found is unknown, never a flag");

  // ── deployer_cluster ──
  const funded = new FakeHelius({ [DEV]: [tx({ signature: "f0", timestamp: T0 - 5 * DAY, nativeTransfers: [{ fromUserAccount: CEX, toUserAccount: DEV, amount: 1e9 }] })] });
  r = await checkDeployerCluster(ctxOf(funded, new Map([[CEX, [DEV, "SIBLINGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1"]]])), DEV);
  assert.equal(r.result, "flag", "sibling deployer under the same funding source is a flag");
  r = await checkDeployerCluster(ctxOf(funded, new Map([[CEX, [DEV]]])), DEV); assert.equal(r.result, "pass");
  r = await checkDeployerCluster(ctxOf(new FakeHelius({ [DEV]: [] })), DEV); assert.equal(r.result, "unknown");

  // ── aggregate ──
  const rep = await scanLaunch(ctxOf(bundled), DEV, MINT, T0 * 1000);
  assert.equal(rep.checks.length, 4); assert.equal(rep.score, preScore(rep.checks)); assert.ok(rep.score <= 100 - 22 * rep.flags);
  assert.equal(preScore([{ id: "liquidity", result: "unknown", detail: "", evidence: [] }]), 100, "unknown does not cost points");
  console.log("scanner: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
