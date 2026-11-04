/**
 * On-chain oracle: signs the program instructions the rulebook assigns to the oracle key
 * (write_score, mark_replaced, write_election_result; assign_seat and execute_ban are sent by the committee tooling). Encoded by hand against program/programs/twenty/src/lib.rs
 * so the API does not depend on an IDL: Anchor discriminator = sha256("global:<name>")[0..8], args in borsh order.
 *
 * Disabled (every call returns null) unless PROGRAM_ID and SCORE_ORACLE_KEYPAIR are set — the database stays the
 * source of truth for the site either way, and `scores.oracle_sig` records which writes made it on chain.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

export interface Oracle {
  enabled: boolean;
  pubkey: string | null;
  writeScore(seat: number, score: number, inputsHash: string): Promise<string | null>;
  markReplaced(seat: number): Promise<string | null>;
  writeElectionResult(season: number, winner: string, tallyRoot: string, ballots: number, turnoutBps: number): Promise<string | null>;
}

export const disabledOracle: Oracle = { enabled: false, pubkey: null, async writeScore() { return null; }, async markReplaced() { return null; }, async writeElectionResult() { return null; } };

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const hex32 = (h: string) => { const b = Buffer.from(h, "hex"); if (b.length !== 32) throw new Error("hash must be 32 bytes"); return b; };

/** A keypair file path, or (for hosts without files, e.g. Railway) the 64-byte JSON array itself in the variable. */
export function loadKeypair(pathOrJson: string): Keypair {
  const t = pathOrJson.trim();
  const raw = JSON.parse(t.startsWith("[") ? t : readFileSync(t, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function makeOracle(opts: { programId?: string; keypairPath?: string; rpcUrl?: string; log?: (o: unknown, m?: string) => void } = {}): Oracle {
  const programId = opts.programId ?? process.env.PROGRAM_ID, keypairPath = opts.keypairPath ?? process.env.SCORE_ORACLE_KEYPAIR;
  if (!programId || !keypairPath) return disabledOracle;
  const program = new PublicKey(programId), signer = loadKeypair(keypairPath);
  const rpc = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://${process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet"}.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.devnet.solana.com");
  const conn = new Connection(rpc, "confirmed");
  const log = opts.log ?? (() => {});
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const padPda = pda([Buffer.from("pad")]);
  const seatPda = (seat: number) => pda([Buffer.from("seat"), u8(seat)]);

  async function send(ix: TransactionInstruction, label: string): Promise<string | null> {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: "confirmed", maxRetries: 3 });
      log({ sig, label }, "oracle write confirmed"); return sig;
    } catch (e) { log({ err: (e as Error).message, label }, "oracle write failed"); return null; }
  }

  return {
    enabled: true, pubkey: signer.publicKey.toBase58(),
    writeScore(seat, score, inputsHash) {
      const data = Buffer.concat([disc("write_score"), u8(score), hex32(inputsHash)]);
      return send(new TransactionInstruction({ programId: program, keys: [
        { pubkey: padPda, isSigner: false, isWritable: false }, { pubkey: seatPda(seat), isSigner: false, isWritable: true }, { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ], data }), `write_score seat ${seat}`);
    },
    markReplaced(seat) {
      return send(new TransactionInstruction({ programId: program, keys: [
        { pubkey: padPda, isSigner: false, isWritable: false }, { pubkey: seatPda(seat), isSigner: false, isWritable: true }, { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ], data: disc("mark_replaced") }), `mark_replaced seat ${seat}`);
    },
    writeElectionResult(season, winner, tallyRoot, ballots, turnoutBps) {
      const data = Buffer.concat([disc("write_election_result"), u16(season), new PublicKey(winner).toBuffer(), hex32(tallyRoot), u32(ballots), u16(turnoutBps)]);
      return send(new TransactionInstruction({ programId: program, keys: [
        { pubkey: padPda, isSigner: false, isWritable: false }, { pubkey: pda([Buffer.from("election"), u16(season)]), isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data }), `write_election_result season ${season}`);
    },
  };
}

/** Exposed for tests: the exact bytes the program expects. */
export const encode = { disc, u8, u16, u32, u64, hex32 };
