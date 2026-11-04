/**
 * Signed requests. A wallet proves a request by signing this exact text with ed25519 (`signMessage` in every
 * Solana wallet). The text names the action, the wallet, a nonce, the time and a hash of the JSON body, so a
 * signature cannot be replayed, moved to another action, or attached to a different body.
 * The site builds the same text in web/dev.js — keep the two in sync (test: packages/api/test/lifecycle).
 */
export type SignedAction =
  | "book slot" | "cancel slot" | "register launch" | "file report" | "apply" | "flag application"
  | "challenge" | "holder vote" | "committee vote" | "propose decision" | "declare candidacy" | "ballot";

export const SIGNED_HEADERS = { wallet: "x-wallet", signature: "x-signature", nonce: "x-nonce", issued: "x-issued" } as const;
export const SIGNATURE_WINDOW_MS = 10 * 60_000;

export function signedMessage(action: SignedAction, wallet: string, nonce: string, issuedAt: string, bodyHash: string): string {
  return `Cadre · ${action}\nwallet: ${wallet}\nnonce: ${nonce}\nissued: ${issuedAt}\nbody: ${bodyHash}\n\nThis signature authorises one request. It never spends funds.`;
}

/** Stable JSON for hashing: keys sorted, no whitespace, so client and server hash the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
}
