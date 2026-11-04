/**
 * `npm run program:init -- --payer keys/deployer.json --committee keys/c1.json,…,keys/c5.json --oracle keys/oracle.json [--send]`
 * Dry run by default: prints the plan and what it would create. `--send` submits; an already initialised pad is checked
 * against the expected committee and oracle instead of being touched. Mainnet needs `--i-know-this-is-mainnet`.
 * Entries for --committee / --oracle may be wallet addresses or keypair files (the public key is used).
 */
import { readFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { initializeIx, padAddress, decodePad, programDataAddress, upgradeAuthority } from "./program-client.js";

const arg = (n: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes("--" + n);
const die = (m: string): never => { console.error("✗ " + m); process.exit(1); };
const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
const pub = (v: string) => { if (existsSync(v)) return loadKp(v).publicKey; try { return new PublicKey(v); } catch { return die(`"${v}" is neither a wallet address nor a keypair file`); } };

const cluster = process.env.SOLANA_CLUSTER ?? "mainnet-beta";
if (cluster === "mainnet-beta" && !flag("i-know-this-is-mainnet")) die("SOLANA_CLUSTER is mainnet-beta (or unset). This sets the committee and oracle for real money; pass --i-know-this-is-mainnet if that is the point.");
const rpc = arg("rpc") ?? process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://${cluster === "devnet" ? "devnet" : "mainnet"}.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : cluster === "devnet" ? "https://api.devnet.solana.com" : die("no RPC: set SOLANA_RPC_URL or HELIUS_API_KEY"));
const programId = arg("program") ?? process.env.PROGRAM_ID ?? die("no program id: --program or PROGRAM_ID");
const program = new PublicKey(programId);
const payerPath = arg("payer") ?? die("--payer <keypair file> is required"); const payer = loadKp(payerPath);
const committee = (arg("committee") ?? die("--committee needs five comma-separated addresses or keypair files")).split(",").map((s) => pub(s.trim()));
const oracle = pub(arg("oracle") ?? process.env.SCORE_ORACLE_KEYPAIR ?? die("--oracle (address or keypair file) is required"));
if (committee.length !== 5) die(`the committee has exactly five members, got ${committee.length}`);

const conn = new Connection(rpc, "confirmed");
console.log(`cluster      ${cluster}\nprogram      ${program.toBase58()}\npad PDA      ${padAddress(program).toBase58()}\npayer        ${payer.publicKey.toBase58()}\noracle       ${oracle.toBase58()}\ncommittee    ${committee.map((k) => k.toBase58()).join("\n             ")}`);

const prog = await conn.getAccountInfo(program); if (!prog?.executable) die("the program is not deployed on this cluster (anchor deploy first)");
const pd = await conn.getAccountInfo(programDataAddress(program)); const authority = pd ? upgradeAuthority(pd.data) : null;
console.log(`upgrade auth ${authority ?? "(none — the program is immutable)"}`);
const existing = await conn.getAccountInfo(padAddress(program));
if (existing) {
  const pad = decodePad(existing.data); const same = pad.oracle === oracle.toBase58() && pad.committee.join() === committee.map((k) => k.toBase58()).join();
  console.log(same ? "\n✓ the pad is already initialised with exactly this committee and oracle — nothing to do" : "\n✗ the pad is already initialised with DIFFERENT keys:\n   oracle " + pad.oracle + "\n   committee " + pad.committee.join(", "));
  process.exit(same ? 0 : 1);
}
if (authority !== payer.publicKey.toBase58()) die(`only the program's upgrade authority can initialise it: ${authority ?? "none (immutable)"} is the authority, the payer is ${payer.publicKey.toBase58()}. Use the deployer keypair as --payer.`);
const ix = initializeIx(program, payer.publicKey, committee, oracle);
if (!flag("send")) { console.log("\n(dry run) would call initialize — add --send to submit"); process.exit(0); }
const balance = await conn.getBalance(payer.publicKey); if (balance < 5_000_000) die(`payer holds ${(balance / 1e9).toFixed(4)} SOL — the two accounts need rent and a fee`);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]); console.log("\nsent", sig);
const after = await conn.getAccountInfo(padAddress(program)); if (!after) die("the pad account does not exist after the transaction");
const pad = decodePad(after!.data);
if (pad.oracle !== oracle.toBase58() || pad.committee.join() !== committee.map((k) => k.toBase58()).join()) die("the pad exists but does not hold the expected keys — someone else initialised it first. Redeploy under a new program id.");
console.log("✓ initialised and verified: committee and oracle read back from chain");
