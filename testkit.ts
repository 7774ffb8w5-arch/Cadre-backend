/**
 * Test kit (also the engine behind `npm run demo`): a real Postgres (PGlite, in-process) with the production schema, a fake Helius whose chain we
 * script, a fake market feed, a controllable clock, wallets that sign requests the way the site does.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import type { Db } from "@twenty/shared";
import { signedMessage, canonicalJson, SIGNED_HEADERS, type SignedAction } from "@twenty/shared";
import { Helius, type ParsedTx } from "@twenty/scanner";
import { base58 } from "./billing.js";
import { makeCtx } from "./runtime.js";
import { disabledOracle } from "./oracle.js";
import type { Ctx } from "./ctx.js";
import { createHash } from "node:crypto";

/**
 * The database's clock follows the test clock: `public.now()` shadows `pg_catalog.now()` (search_path puts public
 * first) and reads the session setting the wrapper refreshes before every query. Column defaults bind to it too
 * because it exists before the schema runs. Production code is untouched: there, now() is the wall clock, like Date.now().
 */
export async function freshDb(clock: { now: number } = { now: Date.now() }): Promise<Db & { pg: PGlite }> {
  if (process.env.TEST_DATABASE_URL) return realDb(clock) as unknown as Db & { pg: PGlite };
  const pg = new PGlite();
  await pg.exec(`create function public.now() returns timestamptz language sql stable as $$ select to_timestamp(coalesce(nullif(current_setting('twenty.now', true), ''), '0')::float8 / 1000.0) $$; set search_path = public, pg_catalog;`);
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").replace(/create extension if not exists pgcrypto;/, "");
  await pg.query("select set_config('twenty.now', $1, false)", [String(clock.now)]);
  await pg.exec(schema);
  let lastSet = clock.now;
  const query = async (sql: string, params: unknown[] = []) => {
    if (clock.now !== lastSet) { await pg.query("select set_config('twenty.now', $1, false)", [String(clock.now)]); lastSet = clock.now; }
    const r = await pg.query(sql, params.map(fix));
    return { rows: r.rows as any[], rowCount: /^\s*(insert|update|delete)/i.test(sql) ? (r.affectedRows ?? r.rows.length) : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), end: () => pg.close(), pg };
}
/** PGlite serialises most things like node-pg; plain objects must go as JSON text, bigint as text. */
const fix = (v: unknown) => (typeof v === "bigint" ? v.toString() : v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);

export interface Wallet { kp: nacl.SignKeyPair; address: string }
export const wallet = (): Wallet => { const kp = nacl.sign.keyPair(); return { kp, address: base58(Buffer.from(kp.publicKey)) }; };
export const sign = (w: Wallet, msg: string) => base58(Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), w.kp.secretKey)));
let nonceSeq = 0;
/** Headers for a signed request, exactly as web/dev.js builds them. */
export function signedHeaders(w: Wallet, action: SignedAction, body: unknown, nowMs = Date.now()) {
  const nonce = "n" + String(++nonceSeq).padStart(15, "0") + Math.random().toString(36).slice(2, 10), issued = new Date(nowMs).toISOString();
  const bodyHash = createHash("sha256").update(canonicalJson(body ?? {})).digest("hex");
  return { [SIGNED_HEADERS.wallet]: w.address, [SIGNED_HEADERS.signature]: sign(w, signedMessage(action, w.address, nonce, issued, bodyHash)), [SIGNED_HEADERS.nonce]: nonce, [SIGNED_HEADERS.issued]: issued, "content-type": "application/json" };
}

/** A scripted chain: creations, holders, assets and treasury transfers the tests push in. */
export class FakeChain {
  creations = new Map<string, { feePayer: string; timestamp: number; signature: string; source: string }>();
  holders = new Map<string, { owner: string; amount: bigint }[]>();
  assets = new Map<string, { supply: number; decimals: number; symbol?: string }>();
  treasuryTxs: (ParsedTx & { instructions?: { programId: string; data: string }[] })[] = [];
  quotes = new Map<string, { priceUsd: number; mcapUsd?: number; liquidityUsd?: number }>();
  mintSeq = 0;
  newMint() { const w = wallet(); return w.address; }
  create(mint: string, feePayer: string, timestampMs: number, source = "PUMP_FUN") { this.creations.set(mint, { feePayer, timestamp: Math.floor(timestampMs / 1000), signature: "sig" + mint.slice(0, 10), source }); if (!this.assets.has(mint)) this.assets.set(mint, { supply: 1_000_000_000 * 1e6, decimals: 6, symbol: "TKN" }); }
  pay(memo: string, from: string, to: string, lamports: number) {
    const sig = "pay" + (++this.mintSeq) + memo;
    this.treasuryTxs.unshift({ signature: sig, slot: 1, timestamp: Math.floor(Date.now() / 1000), type: "TRANSFER", source: "SYSTEM_PROGRAM", fee: 5000, feePayer: from, nativeTransfers: [{ fromUserAccount: from, toUserAccount: to, amount: lamports }], tokenTransfers: [], instructions: [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", data: base58(Buffer.from(memo, "utf8")) }] });
    return sig;
  }
  helius(): Helius {
    const self = this;
    const h = Object.create(Helius.prototype) as Helius;
    Object.assign(h, {
      async transactions(address: string) { return self.treasuryTxs.slice(0, 50); },
      async *walk(address: string) { for (const [mint, c] of self.creations) if (c.feePayer === address) yield { signature: c.signature, slot: 1, timestamp: c.timestamp, type: "CREATE", source: c.source, fee: 0, feePayer: address, nativeTransfers: [], tokenTransfers: [{ fromUserAccount: null, toUserAccount: address, fromTokenAccount: null, toTokenAccount: null, tokenAmount: 1, mint }] } as ParsedTx; },
      async rpcCall(method: string, params: unknown) { if (method === "getLatestBlockhash") return { value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 123456 } } as never; throw new Error("rpc not scripted: " + method); },
      async asset(mint: string) { const a = self.assets.get(mint); return a ? { id: mint, interface: "FungibleToken", token_info: { supply: a.supply, decimals: a.decimals }, content: { metadata: { symbol: a.symbol } } } : null; },
      async largestAccounts() { return { value: [] }; },
      async supply(mint: string) { const a = self.assets.get(mint); return a ? a.supply / 10 ** a.decimals : 0; },
      async holders(mint: string) { return (self.holders.get(mint) ?? []).map((x) => ({ ...x })); },
    });
    return h;
  }
  fetch(): typeof fetch {
    const self = this;
    return (async (url: string | URL | Request) => {
      const u = String(url); const m = u.match(/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      const q = m ? self.quotes.get(m[1]) : undefined;
      if (!q) return new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ pairs: [{ chainId: "solana", priceUsd: String(q.priceUsd), marketCap: q.mcapUsd, liquidity: { usd: q.liquidityUsd ?? 10000 } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }
}

/** The scanner's `creation()` reads helius.walk(mint) → script it: a mint's own history contains its create tx. */
export function scriptCreationLookup(chain: FakeChain, h: Helius) {
  const orig = (h as unknown as { walk: Helius["walk"] }).walk;
  (h as unknown as { walk: unknown }).walk = async function* (address: string, max?: number) {
    const c = chain.creations.get(address);
    if (c) { yield { signature: c.signature, slot: 1, timestamp: c.timestamp, type: "CREATE", source: c.source, fee: 0, feePayer: c.feePayer, nativeTransfers: [], tokenTransfers: [{ fromUserAccount: null, toUserAccount: c.feePayer, fromTokenAccount: null, toTokenAccount: null, tokenAmount: 1, mint: address }] } as ParsedTx; return; }
    yield* orig.call(h, address, max);
  };
}

export const ANCHOR = Date.parse("2026-10-12T00:00:00Z");
export function makeTestCtx(pool: Db, chain: FakeChain, clock: { now: number }, treasury: string): Ctx {
  const h = chain.helius(); scriptCreationLookup(chain, h);
  return makeCtx({ pool, helius: h, fetch: chain.fetch(), now: () => clock.now, anchorMs: ANCHOR, oracle: disabledOracle, treasury, log: { info() {}, warn() {}, error(o, m) { if (process.env.TEST_VERBOSE) console.error(m, o); } } });
}
/** The slot at `h` UTC on the day `daysFromNow` days after `nowMs`. */
export const slotAt = (nowMs: number, daysFromNow: number, h: 14 | 20) => { const d = new Date(nowMs + daysFromNow * 86_400_000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h); };

/**
 * `TEST_DATABASE_URL=postgres://… npm test`: the same tests against a real Postgres server (each freshDb() wipes the
 * `public` schema and applies db/schema.sql). Catches what PGlite is lenient about. Same clock trick as above, per connection.
 */
async function realDb(clock: { now: number }): Promise<Db> {
  const { default: pgmod } = await import("pg");
  const pool = new pgmod.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: "-c search_path=public,pg_catalog" });
  pgmod.types.setTypeParser(20, (v: string) => v); // bigint as text, like PGlite
  const setup = await pool.connect();
  await setup.query("drop schema public cascade; create schema public;");
  await setup.query(`create function public.now() returns timestamptz language sql stable as $$ select to_timestamp(coalesce(nullif(current_setting('twenty.now', true), ''), '0')::float8 / 1000.0) $$`);
  await setup.query("select set_config('twenty.now', $1, false)", [String(clock.now)]);
  await setup.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  setup.release();
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<any> }) => {
    let last = -1;
    return async (sql: string, params: unknown[] = []) => {
      if (clock.now !== last) { await c.query("select set_config('twenty.now', $1, false)", [String(clock.now)]); last = clock.now; }
      const r = await c.query(sql, params.map(fix));
      return { rows: r.rows as any[], rowCount: r.rowCount };
    };
  };
  return { query: wrap(pool), connect: async () => { const c = await pool.connect(); return { query: wrap(c), release: () => c.release() }; }, end: () => pool.end() } as Db;
}
