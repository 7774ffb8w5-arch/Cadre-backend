/** Devnet preparation: the amount scale can never leak onto mainnet, and the pre-flight reads the cluster, program and keys honestly. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { amountScale, PAD } from "@twenty/shared";
import { preflight, summary, GENESIS } from "../src/preflight.js";

test("amountScale: only on devnet, only integers 1–1000", () => {
  assert.equal(amountScale({ SOLANA_CLUSTER: "devnet", AMOUNT_SCALE: "100" }), 100);
  assert.equal(amountScale({ SOLANA_CLUSTER: "mainnet-beta", AMOUNT_SCALE: "100" }), 1, "mainnet ignores it");
  assert.equal(amountScale({ AMOUNT_SCALE: "100" }), 1, "no cluster = mainnet");
  for (const bad of ["0", "-5", "1.5", "abc", "100000", ""]) assert.equal(amountScale({ SOLANA_CLUSTER: "devnet", AMOUNT_SCALE: bad }), 1, bad);
  assert.equal(PAD.SLOT_FEE_SOL, 3, "the test process runs unscaled"); assert.equal(PAD.MISSED_SLOT_FINE_SOL, 5);
});

const oracle = Keypair.generate(); const treasury = Keypair.generate().publicKey.toBase58(); const program = Keypair.generate().publicKey.toBase58();
const rpc = (o: { genesis?: string; executable?: boolean | null; balance?: number } = {}): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
  const { method } = JSON.parse(String(init?.body)); const result = method === "getGenesisHash" ? (o.genesis ?? GENESIS.devnet) : method === "getBalance" ? { value: o.balance ?? 1e9 } : method === "getAccountInfo" ? { value: o.executable === null ? null : { executable: o.executable ?? true } } : null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}) as typeof fetch;
const good = { SOLANA_CLUSTER: "devnet", AMOUNT_SCALE: "100", SOLANA_RPC_URL: "https://rpc.test", TREASURY_WALLET: treasury, PROGRAM_ID: program, SCORE_ORACLE_KEYPAIR: JSON.stringify([...oracle.secretKey]), KEY_PEPPER: "p".repeat(24), HELIUS_WEBHOOK_SECRET: "w".repeat(24), DATABASE_URL: "postgres://x", VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", TELEGRAM_BOT_TOKEN: "t", PUBLIC_SITE_URL: "https://dev.cadre-us.org", SEASON_ANCHOR_UTC: "2026-11-02T00:00:00Z" };
const by = (cs: Awaited<ReturnType<typeof preflight>>, id: string) => cs.find((c) => c.id === id)!;

test("preflight: a complete devnet environment passes", async () => {
  const cs = await preflight(good, rpc()); assert.deepEqual(summary(cs), { fail: 0, warn: 0, pass: cs.length }, JSON.stringify(cs.filter((c) => c.level !== "pass")));
});

test("preflight: wrong network, missing program, empty oracle, bad secrets are called out", async () => {
  assert.equal(by(await preflight(good, rpc({ genesis: GENESIS.mainnet })), "rpc").level, "fail", "RPC on mainnet while expecting devnet");
  const np = await preflight(good, rpc({ executable: null })); assert.equal(by(np, "program").level, "fail"); assert.match(by(np, "program").detail, /not deployed/);
  assert.equal(by(await preflight(good, rpc({ executable: false })), "program").level, "fail");
  assert.equal(by(await preflight(good, rpc({ balance: 1000 })), "oracle").level, "warn");
  const weak = await preflight({ ...good, KEY_PEPPER: "short", HELIUS_WEBHOOK_SECRET: undefined, DATABASE_URL: undefined, TREASURY_WALLET: "nope", SCORE_ORACLE_KEYPAIR: "[1,2]" }, rpc());
  for (const id of ["KEY_PEPPER", "HELIUS_WEBHOOK_SECRET", "DATABASE_URL", "treasury", "oracle"]) assert.equal(by(weak, id).level, "fail", id);
  assert.equal(by(await preflight({ ...good, SOLANA_CLUSTER: "mainnet-beta" }, rpc()), "cluster").level, "fail", "env says mainnet in a devnet run");
  assert.equal(by(await preflight({ ...good, AMOUNT_SCALE: undefined }, rpc()), "amounts").level, "warn");
  assert.equal(by(await preflight({ ...good, SOLANA_RPC_URL: undefined, HELIUS_API_KEY: undefined }, rpc()), "rpc").level, "fail");
  assert.equal(by(await preflight(good, rpc(), { anchorProgramId: Keypair.generate().publicKey.toBase58() }), "program-id").level, "warn", "Anchor.toml id differs");
});

test("preflight: the oracle keypair is a file path, as the oracle itself reads it", async () => {
  const withPath = { ...good, SCORE_ORACLE_KEYPAIR: "/keys/oracle.json" };
  assert.equal(by(await preflight(withPath, rpc(), { read: () => JSON.stringify([...oracle.secretKey]) }), "oracle").level, "pass");
  assert.equal(by(await preflight(withPath, rpc(), { read: () => { throw new Error("ENOENT"); } }), "oracle").level, "fail");
});

test("preflight on mainnet refuses a leftover AMOUNT_SCALE and a devnet RPC", async () => {
  const m = { ...good, SOLANA_CLUSTER: "mainnet-beta" };
  assert.equal(by(await preflight(m, rpc(), { cluster: "mainnet-beta" }), "amounts").level, "fail");
  assert.equal(by(await preflight({ ...m, AMOUNT_SCALE: undefined }, rpc({ genesis: GENESIS.devnet }), { cluster: "mainnet-beta" }), "rpc").level, "fail");
});
