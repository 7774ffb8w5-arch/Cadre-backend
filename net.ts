/**
 * Outbound-request safety shared by the API (rule creation) and the bot (delivery).
 *  - assertSafeWebhook: SSRF guard — https only, public hostnames only, DNS resolved, no credentials, no odd ports
 *  - postWebhook: 5 s timeout, no redirects, bounded response, HMAC-SHA256 signature receivers can verify
 *  - timingEqual: constant-time compare for secrets
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
}
/** Expands any textual IPv6 form (including "::", embedded IPv4 and bracketed) into eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const o = v4[1].split(".").map(Number); if (o.some((n) => n > 255)) return null; x = x.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16); }
  const halves = x.split("::"); if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0; if (fill < 0 || head.length + tail.length + fill !== 8) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : groups;
}
function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip); if (!g) return true;
  const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPrivateV4(v4(g[6], g[7]));          // ::ffff:a.b.c.d  (IPv4-mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isPrivateV4(v4(g[6], g[7])); // 64:ff9b::/96 (NAT64)
  if (g.slice(0, 6).every((n) => n === 0) && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;           // :: and ::1
  if (g.slice(0, 6).every((n) => n === 0)) return isPrivateV4(v4(g[6], g[7]));                                 // ::a.b.c.d (IPv4-compatible, deprecated)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff00) === 0xff00) return true;     // link-local, ULA, multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                                                          // documentation
  if (g[0] === 0x2002) return isPrivateV4(v4(g[1], g[2]));                                                      // 6to4 carries a v4 address
  return false;
}
/** True for loopback, link-local, RFC 1918, CGNAT, multicast, documentation and anything that is not an IP at all. */
export function isPrivateIp(ip: string): boolean { return isIP(ip) === 4 ? isPrivateV4(ip) : isIP(ip) === 6 ? isPrivateV6(ip) : true; }

export const WEBHOOK_MAX_URL = 400;
/** Validates a webhook target and resolves its host so a name cannot point inside the network. Throws with a user-safe message. */
export async function assertSafeWebhook(target: string, resolve: (host: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<URL> {
  if (typeof target !== "string" || target.length > WEBHOOK_MAX_URL) throw new Error("target too long");
  let u: URL; try { u = new URL(target); } catch { throw new Error("target must be a URL"); }
  if (u.protocol !== "https:") throw new Error("target must use https");
  if (u.username || u.password) throw new Error("target must not carry credentials");
  if (u.port && !["443", "8443"].includes(u.port)) throw new Error("target port must be 443 or 8443");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa") || !host.includes(".") && !isIP(host)) throw new Error("target host not allowed");
  if (isIP(host)) { if (isPrivateIp(host)) throw new Error("target host not allowed"); return u; }
  const addrs = await resolve(host).catch(() => [] as { address: string }[]);
  if (!addrs.length) throw new Error("target host does not resolve");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("target host resolves to a private address");
  return u;
}

export function signWebhook(secret: string, ts: number, raw: string): string {
  return "v1=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
}
export function timingEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** Verifies `x-twenty-signature` on the receiving side; receivers get this snippet in docs/API.md. */
export function verifyWebhookSignature(secret: string, ts: string | number, raw: string, header: string, maxSkewSec = 300): boolean {
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > maxSkewSec) return false;
  return timingEqual(signWebhook(secret, t, raw), header);
}

/** POSTs JSON to a validated target: 5 s timeout, redirects refused, response body ignored. Returns the status code. */
export async function postWebhook(target: string, secret: string | null, body: unknown, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<number> {
  await assertSafeWebhook(target);
  const raw = JSON.stringify(body); const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json", "x-twenty-timestamp": String(ts), "user-agent": "the-twenty-alerts/1" };
  if (secret) headers["x-twenty-signature"] = signWebhook(secret, ts, raw);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetchImpl(target, { method: "POST", redirect: "manual", signal: ctrl.signal, headers, body: raw }); return r.status; }
  finally { clearTimeout(t); }
}
