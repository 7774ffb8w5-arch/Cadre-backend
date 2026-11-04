/**
 * Market quotes for launches: price, market cap and liquidity in USD. DexScreener first (covers Raydium, Meteora,
 * pump.fun after migration), Jupiter price as a fallback for bonding-curve tokens. Every call: 8 s timeout,
 * no redirects, response validated field by field. Returns null when no source has the token yet.
 */
export interface MarketQuote { priceUsd: number; mcapUsd: number | null; liquidityUsd: number | null; source: "dexscreener" | "jupiter" }

const num = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetchImpl(url, { signal: ctrl.signal, redirect: "error", headers: { accept: "application/json", "user-agent": "the-twenty-snapshots/1" } }); if (!r.ok) return null; return await r.json(); }
  catch { return null; } finally { clearTimeout(t); }
}

export async function dexscreener(fetchImpl: typeof fetch, mint: string): Promise<MarketQuote | null> {
  const j = (await getJson(fetchImpl, `https://api.dexscreener.com/latest/dex/tokens/${mint}`)) as { pairs?: unknown } | null;
  const pairs = Array.isArray(j?.pairs) ? (j!.pairs as Record<string, unknown>[]) : [];
  const sol = pairs.filter((p) => p && p.chainId === "solana" && num(p.priceUsd) !== null);
  if (!sol.length) return null;
  const best = sol.sort((a, b) => (num((b.liquidity as { usd?: unknown })?.usd) ?? 0) - (num((a.liquidity as { usd?: unknown })?.usd) ?? 0))[0];
  return { priceUsd: num(best.priceUsd)!, mcapUsd: num(best.marketCap) ?? num(best.fdv), liquidityUsd: num((best.liquidity as { usd?: unknown })?.usd), source: "dexscreener" };
}

export async function jupiter(fetchImpl: typeof fetch, mint: string): Promise<MarketQuote | null> {
  const j = (await getJson(fetchImpl, `https://lite-api.jup.ag/price/v2?ids=${mint}`)) as { data?: Record<string, { price?: unknown }> } | null;
  const p = num(j?.data?.[mint]?.price);
  return p !== null && p > 0 ? { priceUsd: p, mcapUsd: null, liquidityUsd: null, source: "jupiter" } : null;
}

export async function quote(fetchImpl: typeof fetch, mint: string): Promise<MarketQuote | null> {
  if (!MINT.test(mint)) return null;
  return (await dexscreener(fetchImpl, mint)) ?? (await jupiter(fetchImpl, mint));
}
