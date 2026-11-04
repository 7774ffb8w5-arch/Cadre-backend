/**
 * Security tests for @twenty/api. Runs without Postgres: `pg.Pool` is stubbed per test with canned rows.
 *   npm test -w @twenty/api
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";

process.env.DATABASE_URL = "postgres://stub"; process.env.HELIUS_API_KEY = "x"; process.env.KEY_PEPPER = "test-pepper"; process.env.TRUST_PROXY = "false";
process.env.HELIUS_WEBHOOK_SECRET = "hook-secret"; process.env.TREASURY_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; process.env.LOG_LEVEL = "silent";

/* ── a tiny fake pool: each query is matched by a substring → rows ── */
type Rows = Record<string, unknown>[];
const canned: { match: string; rows: Rows | ((params: unknown[]) => Rows) }[] = [];
const seen: { sql: string; params: unknown[] }[] = [];
class FakePool {
  async query(sql: string, params: unknown[] = []) {
    seen.push({ sql, params });
    const hit = canned.find((c) => sql.includes(c.match));
    const rows = hit ? (typeof hit.rows === "function" ? hit.rows(params) : hit.rows) : [];
    return { rows, rowCount: rows.length };
  }
  async connect() { const self = this; return { query: (sql: string, p?: unknown[]) => self.query(sql, p), release() {} }; }
  async end() {}
}
const { build } = await import("../src/server.js");
const { Helius } = await import("@twenty/scanner");
const { keyHash, ballotMessage, verifyWalletSignature, nonceFresh } = await import("../src/security.js");
const { assertSafeWebhook, verifyWebhookSignature, signWebhook, isPrivateIp } = await import("@twenty/shared");
const app = await build({ pool: new FakePool() as never, helius: new Helius("x", "mainnet-beta", (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch) });
const reset = () => { canned.length = 0; seen.length = 0; };
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("headers: helmet + CORS + nosniff + cache policy", async () => {
  reset(); canned.push({ match: "from ledger", rows: [{ pool: "0", treasury: "0" }] }, { match: "count(*)::int as n from launches", rows: [{ n: 0 }] }, );
  const r = await app.inject({ method: "GET", url: "/v1/pad", headers: { origin: "https://cadre-us.org" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(r.headers["cache-control"], "public, max-age=15");
  const p = await app.inject({ method: "OPTIONS", url: "/v1/scan/x", headers: { origin: "https://x.y", "access-control-request-method": "GET", "access-control-request-headers": "x-wallet" } });
  assert.match(String(p.headers["access-control-allow-headers"]), /x-wallet/);
  assert.doesNotMatch(String(p.headers["access-control-allow-headers"]), /x-api-key/, "no API keys exist");
});

test("validation: bad params/query never reach the handler", async () => {
  reset();
  for (const url of ["/v1/log?limit=abc", "/v1/log?limit=0", "/v1/log?limit=9999", "/v1/log?type=DROP%20TABLE", "/v1/scan/not-an-address", "/v1/verify/0x1234", "/v1/polls/Bad%20Id"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 400, url); assert.equal(seen.length, 0, url + " hit the database");
  }
  const ok = await app.inject({ method: "GET", url: "/v1/log?limit=5&type=ban" });
  assert.equal(ok.statusCode, 200); assert.deepEqual(seen[0].params, ["ban", null, 5]);
});

test("errors: 5xx details stay inside, 404 is JSON", async () => {
  reset(); canned.push({ match: "from ledger", rows: () => { throw new Error("relation \"ledger\" does not exist at /secret/path"); } });
  const r = await app.inject({ method: "GET", url: "/v1/pad" });
  assert.equal(r.statusCode, 500); assert.doesNotMatch(r.body, /secret|relation/); assert.match(r.body, /"ref"/);
  const nf = await app.inject({ method: "GET", url: "/nope" }); assert.equal(nf.statusCode, 404); assert.equal(JSON.parse(nf.body).error, "not found");
});

test("body limit and additionalProperties", async () => {
  reset();
  const big = await app.inject({ method: "POST", url: "/v1/waitlist", payload: { contact: "a".repeat(70 * 1024) } });
  assert.equal(big.statusCode, 413);
  const extra = await app.inject({ method: "POST", url: "/v1/waitlist", payload: { contact: "@hendrik", admin: true } });
  assert.equal(extra.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/v1/waitlist", payload: { contact: "@Hendrik" } });
  assert.equal(ok.statusCode, 200); assert.equal(seen[0].params[0], "@hendrik"); assert.equal(String(seen[0].params[2]).length, 16, "ip is stored hashed");
});

test("no subscriptions: scanner is free, keys/billing/alert routes do not exist", async () => {
  reset();
  for (const [method, url] of [["POST", "/v1/keys/request"], ["GET", "/v1/keys/request/TW-AB12CD34"], ["GET", "/v1/alerts"], ["POST", "/v1/alerts"], ["DELETE", "/v1/alerts/11111111-1111-4111-8111-111111111111"]] as const) {
    const r = await app.inject({ method, url, payload: method === "POST" ? {} : undefined }); assert.equal(r.statusCode, 404, method + " " + url);
  }
  canned.push({ match: "select report from scans", rows: [{ report: { cached: false, verdict: "clean" } }] });
  const out = await app.inject({ method: "GET", url: "/v1/scan/" + WALLET, headers: { "x-api-key": "K".repeat(44) } });
  assert.equal(out.statusCode, 200, "a stray key header changes nothing"); assert.equal(JSON.parse(out.body).cached, true);
  assert.ok(!seen.some((q) => /api_keys|key_requests|alert_rules/.test(q.sql)), "no key tables are touched");
});

test("ssrf guard resolves names; webhook signatures verify", async () => {
  await assert.rejects(assertSafeWebhook("https://internal.example.com/hook", async () => [{ address: "10.0.0.5" }]), /private/);
  await assert.rejects(assertSafeWebhook("https://nope.example.com/hook", async () => []), /resolve/);
  const u = await assertSafeWebhook("https://hooks.example.com/abc", async () => [{ address: "93.184.216.34" }]); assert.equal(u.hostname, "hooks.example.com");
  await assert.rejects(assertSafeWebhook("https://[::1]/x"), /not allowed/);
  await assert.rejects(assertSafeWebhook("https://[::ffff:127.0.0.1]/x"), /not allowed/);
  await assert.rejects(assertSafeWebhook("https://[::ffff:7f00:1]/x"), /not allowed/);
  await assert.rejects(assertSafeWebhook("https://[64:ff9b::a9fe:a9fe]/x"), /not allowed/, "NAT64 metadata");
  await assert.rejects(assertSafeWebhook("https://[2002:7f00:1::1]/x"), /not allowed/, "6to4 loopback");
  await assert.rejects(assertSafeWebhook("https://0x7f.0.0.1/x"), /not allowed/, "octal/hex v4 forms are normalised by URL");
  await assert.rejects(assertSafeWebhook("https://2130706433/x"), /not allowed/, "integer v4");
  await assert.rejects(assertSafeWebhook("https://example.com:8080/x"), /port/);
  assert.equal(isPrivateIp("100.64.1.1"), true); assert.equal(isPrivateIp("8.8.8.8"), false); assert.equal(isPrivateIp("fd00::1"), true);
  const ts = Math.floor(Date.now() / 1000); const sig = signWebhook("s3cret", ts, "{\"a\":1}");
  assert.equal(verifyWebhookSignature("s3cret", ts, "{\"a\":1}", sig), true);
  assert.equal(verifyWebhookSignature("s3cret", ts, "{\"a\":2}", sig), false);
  assert.equal(verifyWebhookSignature("s3cret", ts - 1000, "{\"a\":1}", signWebhook("s3cret", ts - 1000, "{\"a\":1}")), false, "stale timestamp");
});

test("helius webhook: secret required and compared in constant time; payload bounded", async () => {
  reset();
  assert.equal((await app.inject({ method: "POST", url: "/v1/webhooks/helius", payload: [] })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/webhooks/helius", headers: { authorization: "hook-secret" }, payload: { not: "array" } })).statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/v1/webhooks/helius", headers: { authorization: "hook-secret" }, payload: [] });
  assert.equal(ok.statusCode, 200); assert.equal(JSON.parse(ok.body).ingested, 0);
  const saved = process.env.HELIUS_WEBHOOK_SECRET; delete process.env.HELIUS_WEBHOOK_SECRET;
  assert.equal((await app.inject({ method: "POST", url: "/v1/webhooks/helius", payload: [] })).statusCode, 503, "unconfigured webhook refuses instead of accepting everything");
  process.env.HELIUS_WEBHOOK_SECRET = saved;
});

test("ballots: ed25519 signature bound to season, candidate, nonce and time", async () => {
  const kp = nacl.sign.keyPair(); const { base58 } = await import("../src/billing.js");
  const wallet = base58(Buffer.from(kp.publicKey));
  const issued = new Date().toISOString(); const nonce = "n".repeat(20);
  reset(); canned.push({ match: "from elections where", rows: [] });
  const el = await app.inject({ method: "GET", url: "/v1/election" }); assert.equal(el.statusCode, 200, el.body); const season = JSON.parse(el.body).season as number; const phase = JSON.parse(el.body).phase as string;
  const msg = ballotMessage(season, "ava", nonce, issued);
  const sig = base58(Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)));
  assert.equal(verifyWalletSignature(wallet, msg, sig), true);
  assert.equal(verifyWalletSignature(wallet, ballotMessage(season + 1, "ava", nonce, issued), sig), false, "another season");
  assert.equal(verifyWalletSignature(wallet, ballotMessage(season, "bob", nonce, issued), sig), false, "another candidate");
  assert.equal(nonceFresh(new Date(Date.now() - 11 * 60_000).toISOString()), false);
  reset(); canned.push({ match: "from election_snapshot", rows: [{ weight_pct: "0.5000" }] }, { match: "select c.developer_id", rows: [{ developer_id: "d1" }] }, { match: "insert into nonces", rows: [{}] }, { match: "select developer_id from election_ballots", rows: [] });
  const cast = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/election/ballot", payload: body });
  const r = await cast({ wallet, candidate: "ava", signature: sig, nonce, issued_at: issued });
  if (phase === "polls") { assert.equal(r.statusCode, 200, r.body); assert.equal(JSON.parse(r.body).weight_pct, 0.5); assert.equal((await cast({ wallet, candidate: "bob", signature: sig, nonce, issued_at: issued })).statusCode, 401, "signature for another candidate is refused"); }
  else assert.equal(r.statusCode, 409, "outside the polls window every ballot is refused");
  assert.equal((await cast({ wallet, candidate: "ava", signature: "bad", nonce, issued_at: issued })).statusCode, 400);
  assert.equal((await cast({ wallet: "0xdead", candidate: "ava", signature: sig, nonce, issued_at: issued })).statusCode, 400);
});

test("rate limit: free scans per IP", async () => {
  reset(); canned.push({ match: "select report from scans", rows: [{ report: { address: WALLET, cached: false } }] });
  let last = 0; for (let i = 0; i < 8; i++) last = (await app.inject({ method: "GET", url: "/v1/scan/" + WALLET, remoteAddress: "203.0.113.9" })).statusCode;
  assert.equal(last, 429);
});

test.after(async () => { await app.close(); });
