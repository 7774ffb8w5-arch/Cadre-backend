/**
 * Thin Helius client. Uses the Enhanced Transactions API (parsed transfers) and the DAS API
 * (token metadata, holders). Docs: https://docs.helius.dev
 * Only the fields the checks need are typed; the rest is passed through as unknown.
 */

export interface NativeTransfer { fromUserAccount: string; toUserAccount: string; amount: number }
export interface TokenTransfer { fromUserAccount: string | null; toUserAccount: string | null; fromTokenAccount: string | null; toTokenAccount: string | null; tokenAmount: number; mint: string }
export interface ParsedTx {
  signature: string; slot: number; timestamp: number; type: string; source: string; fee: number; feePayer: string;
  nativeTransfers: NativeTransfer[]; tokenTransfers: TokenTransfer[];
  events?: { swap?: unknown };
  accountData?: { account: string; nativeBalanceChange: number; tokenBalanceChanges: { mint: string; rawTokenAmount: { tokenAmount: string; decimals: number }; userAccount: string }[] }[];
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

export class Helius {
  /** Every call: 10 s timeout, up to 3 retries with jittered backoff on 429 / 5xx / network errors. */
  constructor(private apiKey: string, private cluster: "mainnet-beta" | "devnet" = "mainnet-beta", private fetchImpl: typeof fetch = fetch, private opts: { timeoutMs?: number; retries?: number } = {}) {
    if (!apiKey) throw new Error("HELIUS_API_KEY missing");
  }
  private get base() { return this.cluster === "devnet" ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz"; }
  private get rpc() { return this.cluster === "devnet" ? `https://devnet.helius-rpc.com/?api-key=${this.apiKey}` : `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`; }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const retries = this.opts.retries ?? 3, timeout = this.opts.timeoutMs ?? 10_000;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await this.fetchImpl(url, { ...init, signal: ctrl.signal, redirect: "error" });
        if (r.status === 429 || r.status >= 500) { last = r.status === 429 ? new RateLimited() : new Error(`helius ${r.status}`); }
        else return r;
      } catch (e) { last = e; }
      finally { clearTimeout(t); }
      if (attempt < retries) await new Promise((res) => setTimeout(res, Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300));
    }
    throw last instanceof Error ? last : new Error("helius request failed");
  }

  /** Parsed transaction history for an address, newest first. Paginates with `before`. */
  async transactions(address: string, opts: { limit?: number; before?: string; type?: string } = {}): Promise<ParsedTx[]> {
    if (!ADDRESS.test(address)) throw new Error("not a Solana address");
    if (opts.before && !SIGNATURE.test(opts.before)) throw new Error("bad cursor");
    const q = new URLSearchParams({ "api-key": this.apiKey, limit: String(Math.min(100, Math.max(1, opts.limit ?? 100))) });
    if (opts.before) q.set("before", opts.before); if (opts.type && /^[A-Z_]{1,40}$/.test(opts.type)) q.set("type", opts.type);
    const r = await this.request(`${this.base}/v0/addresses/${address}/transactions?${q}`);
    if (!r.ok) throw new Error(`helius ${r.status} for ${address}`);
    const j = await r.json();
    return Array.isArray(j) ? (j as ParsedTx[]) : [];
  }

  /** Walk history until `until(tx)` says stop or `maxPages` is reached. */
  async *walk(address: string, maxPages = 10, until?: (tx: ParsedTx) => boolean): AsyncGenerator<ParsedTx> {
    let before: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const page = await this.transactions(address, { before, limit: 100 });
      if (!page.length) return;
      for (const tx of page) { yield tx; if (until && until(tx)) return; }
      before = page[page.length - 1].signature;
    }
  }

  async rpcCall<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    const r = await this.request(this.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }

  /** DAS getAsset — token metadata incl. supply and (for fungible) token_info. */
  asset(mint: string) { if (!ADDRESS.test(mint)) throw new Error("not a Solana address"); return this.rpcCall<{ id: string; interface: string; token_info?: { supply: number; decimals: number; mint_authority?: string; freeze_authority?: string }; content?: { metadata?: { name?: string; symbol?: string } } }>("getAsset", { id: mint }); }

  /** Largest token accounts for a mint (top 20), enough for concentration and LP detection. */
  largestAccounts(mint: string) { return this.rpcCall<{ value: { address: string; amount: string; decimals: number; uiAmount: number }[] }>("getTokenLargestAccounts", [mint]); }

  /** Token supply (ui amount). */
  async supply(mint: string): Promise<number> { const r = await this.rpcCall<{ value: { uiAmount: number } }>("getTokenSupply", [mint]); return r.value.uiAmount; }

  /** All holders of a mint via getTokenAccounts (DAS, paginated). Used for the holder snapshots and the settle step. */
  async holders(mint: string, maxPages = 50): Promise<{ owner: string; amount: bigint }[]> {
    const out = new Map<string, bigint>(); let cursor: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const r = await this.rpcCall<{ token_accounts: { owner: string; amount: number | string }[]; cursor?: string }>("getTokenAccounts", { mint, limit: 1000, cursor });
      for (const a of r.token_accounts) out.set(a.owner, (out.get(a.owner) ?? 0n) + BigInt(a.amount));
      if (!r.cursor) break; cursor = r.cursor;
    }
    return [...out].map(([owner, amount]) => ({ owner, amount }));
  }
}

export class RateLimited extends Error { constructor() { super("helius rate limited"); this.name = "RateLimited"; } }

/** Known liquidity-lock and burn destinations. Extend as new lockers appear. */
export const KNOWN = {
  INCINERATOR: "1nc1nerator11111111111111111111111111111111",
  LOCKERS: new Map<string, string>([
    ["strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", "Streamflow"],
    ["LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn", "Raydium LP locker"],
  ]),
  AMM_PROGRAMS: new Map<string, string>([
    ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM v4"],
    ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
    ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump.fun"],
    ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pump.fun AMM"],
    ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
    ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Meteora DLMM"],
  ]),
};
