/** The setup client builds exactly the instruction the program expects, and reads the Pad account back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { initializeIx, decodePad, padAddress, programDataAddress, upgradeAuthority } from "../src/program-client.js";

const k = () => Keypair.generate().publicKey; const program = k(), payer = k(), oracle = k(); const committee = [k(), k(), k(), k(), k()];

test("initialize: discriminator, argument layout and accounts", () => {
  const ix = initializeIx(program, payer, committee, oracle);
  assert.equal(ix.data.length, 8 + 32 * 5 + 32);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...createHash("sha256").update("global:initialize").digest().subarray(0, 8)]);
  committee.forEach((m, i) => assert.ok(ix.data.subarray(8 + 32 * i, 40 + 32 * i).equals(m.toBuffer()), "member " + i));
  assert.ok(ix.data.subarray(168).equals(oracle.toBuffer()));
  assert.deepEqual(ix.keys.map((a) => [a.pubkey.toBase58(), a.isSigner, a.isWritable]), [[padAddress(program).toBase58(), false, true], [payer.toBase58(), true, true], [SystemProgram.programId.toBase58(), false, false], [program.toBase58(), false, false], [programDataAddress(program).toBase58(), false, false]]);
});

test("upgradeAuthority: reads the authority from ProgramData, null when immutable", () => {
  const auth = k(); const mk = (some: boolean) => { const b = Buffer.alloc(45); b.writeUInt32LE(3, 0); b[12] = some ? 1 : 0; if (some) auth.toBuffer().copy(b, 13); return b; };
  assert.equal(upgradeAuthority(mk(true)), auth.toBase58()); assert.equal(upgradeAuthority(mk(false)), null);
  assert.throws(() => upgradeAuthority(Buffer.alloc(45)), /ProgramData/); assert.throws(() => upgradeAuthority(Buffer.alloc(10)), /ProgramData/);
});

test("initialize: refuses a committee that is not five distinct wallets", () => {
  assert.throws(() => initializeIx(program, payer, committee.slice(0, 4), oracle), /exactly five/);
  assert.throws(() => initializeIx(program, payer, [...committee.slice(0, 4), committee[0]], oracle), /five different/);
});

test("decodePad: reads committee, oracle and bump; rejects other accounts", () => {
  const data = Buffer.concat([createHash("sha256").update("account:Pad").digest().subarray(0, 8), ...committee.map((m) => m.toBuffer()), oracle.toBuffer(), Buffer.from([254])]);
  const pad = decodePad(data); assert.deepEqual(pad.committee, committee.map((m) => m.toBase58())); assert.equal(pad.oracle, oracle.toBase58()); assert.equal(pad.bump, 254);
  assert.throws(() => decodePad(Buffer.alloc(300)), /discriminator/); assert.throws(() => decodePad(Buffer.alloc(20)), /too small/);
});

/* ── the CLI against a scripted RPC ── */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init CLI: dry run, guard rails and an already-initialised pad", async () => {
  const dir = mkdtempSync(join(tmpdir(), "init-")); const kp = Keypair.generate(); const payerFile = join(dir, "payer.json"); writeFileSync(payerFile, JSON.stringify([...kp.secretKey]));
  const prog = Keypair.generate().publicKey; const mem = committee.map((m) => m.toBase58()).join(",");
  const padData = (cm: typeof committee, orc: typeof oracle) => Buffer.concat([createHash("sha256").update("account:Pad").digest().subarray(0, 8), ...cm.map((m) => m.toBuffer()), orc.toBuffer(), Buffer.from([255])]);
  let pad: Buffer | null = null; let deployed = true; let authority: string | null = kp.publicKey.toBase58();
  const pdBuf = () => { const b = Buffer.alloc(45); b.writeUInt32LE(3, 0); if (authority) { b[12] = 1; new PublicKey(authority).toBuffer().copy(b, 13); } return b; };
  const srv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const { method, params, id } = JSON.parse(b); const addr = params?.[0];
    const info = (data: Buffer, exec: boolean) => ({ context: { slot: 1 }, value: { data: [data.toString("base64"), "base64"], executable: exec, lamports: 1e9, owner: prog.toBase58(), rentEpoch: 0, space: data.length } });
    const result = method === "getAccountInfo" ? (addr === prog.toBase58() ? (deployed ? info(Buffer.alloc(36), true) : { context: { slot: 1 }, value: null }) : addr === programDataAddress(prog).toBase58() ? info(pdBuf(), false) : addr === padAddress(prog).toBase58() && pad ? info(pad, false) : { context: { slot: 1 }, value: null }) : null;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const port = (srv.address() as { port: number }).port;
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, ["--import", "tsx", "src/init-cli.ts", ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: `http://127.0.0.1:${port}`, PROGRAM_ID: prog.toBase58(), ...env } }, (err, stdout, stderr) => resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })));
  const base = ["--payer", payerFile, "--committee", mem, "--oracle", oracle.toBase58()];
  try {
    let r = await run(base); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /dry run/); assert.match(r.stdout, new RegExp(padAddress(prog).toBase58()));
    r = await run(base, { SOLANA_CLUSTER: "mainnet-beta" }); assert.equal(r.status, 1); assert.match(r.stderr, /i-know-this-is-mainnet/);
    r = await run(["--payer", payerFile, "--committee", mem.split(",").slice(0, 4).join(","), "--oracle", oracle.toBase58()]); assert.equal(r.status, 1); assert.match(r.stderr, /exactly five/);
    deployed = false; r = await run(base); assert.equal(r.status, 1); assert.match(r.stderr, /not deployed/); deployed = true;
    authority = Keypair.generate().publicKey.toBase58(); r = await run([...base, "--send"]); assert.equal(r.status, 1); assert.match(r.stderr, /only the program's upgrade authority/); authority = kp.publicKey.toBase58();
    authority = null; r = await run([...base, "--send"]); assert.equal(r.status, 1); assert.match(r.stderr, /immutable/); authority = kp.publicKey.toBase58();
    pad = padData(committee, oracle); r = await run(base); assert.equal(r.status, 0); assert.match(r.stdout, /already initialised with exactly this/);
    pad = padData(committee, k()); r = await run(base); assert.equal(r.status, 1); assert.match(r.stdout, /DIFFERENT keys/);
  } finally { srv.close(); }
});

test("oracle keypair: file path or inline JSON array (hosts without files)", async () => {
  const { loadKeypair } = await import("../src/oracle.js"); const { Keypair } = await import("@solana/web3.js"); const { writeFileSync, mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const kp = Keypair.generate(); const json = JSON.stringify([...kp.secretKey]);
  assert.equal(loadKeypair(json).publicKey.toBase58(), kp.publicKey.toBase58());
  const f = join(mkdtempSync(join(tmpdir(), "kp-")), "k.json"); writeFileSync(f, json);
  assert.equal(loadKeypair(f).publicKey.toBase58(), kp.publicKey.toBase58());
});
