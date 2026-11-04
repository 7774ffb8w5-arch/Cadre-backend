/**
 * Security helpers for the API.
 *  - keyHash: API keys and claim tokens are stored as HMAC-SHA256 with a server pepper (plain SHA-256 if KEY_PEPPER is unset)
 *  - ipHash: a short, peppered hash of the client IP for one-vote / one-signup tables; the IP itself is never stored
 *  - verifyWalletSignature: ed25519 over the canonical ballot text; nonceFresh bounds replay to a 10 min window
 *  - assertSafeWebhook / postWebhook / timingEqual come from @twenty/shared so the bot and the API agree
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
export { assertSafeWebhook, postWebhook, timingEqual, isPrivateIp, signWebhook, verifyWebhookSignature } from "@twenty/shared";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

export function base58Decode(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function keyHash(key: string, pepper = process.env.KEY_PEPPER): string {
  return pepper ? createHmac("sha256", pepper).update(key).digest("hex") : createHash("sha256").update(key).digest("hex");
}
export function ipHash(ip: string): string { return createHash("sha256").update(ip + "|" + (process.env.KEY_PEPPER ?? "")).digest("hex").slice(0, 16); }
export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

/* ── wallet signatures ───────────────────────────────────────── */
export const NONCE_WINDOW_MS = 10 * 60_000;
/** The exact text a wallet signs. It names the action, season, candidate, nonce and time, so it cannot be replayed, moved or reused for anything else. */
export function ballotMessage(season: number, candidate: string, nonce: string, issuedAt: string): string {
  return `Cadre · Seat 20 ballot\nseason: ${season}\ncandidate: ${candidate}\nnonce: ${nonce}\nissued: ${issuedAt}\n\nThis signature casts or moves my ballot. It never spends funds.`;
}
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  if (!BASE58_RE.test(wallet) || !SIG_RE.test(signature)) return false;
  try {
    const pk = base58Decode(wallet), sig = base58Decode(signature);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pk);
  } catch { return false; }
}
export function nonceFresh(issuedAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(issuedAt); return Number.isFinite(t) && Math.abs(nowMs - t) <= NONCE_WINDOW_MS;
}
