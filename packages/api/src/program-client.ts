/**
 * Minimal client for the seat registry program's one-time setup, without the generated IDL: the instruction data is the
 * Anchor discriminator + the arguments, the accounts are the singleton pad PDA. Used by `npm run program:init`.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

const disc = (ns: "global" | "account", name: string) => createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8);
export const padAddress = (program: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("pad")], program)[0];
export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** The ProgramData account the upgradeable loader keeps for a program; it names the upgrade authority. */
export const programDataAddress = (program: PublicKey) => PublicKey.findProgramAddressSync([program.toBuffer()], BPF_UPGRADEABLE_LOADER)[0];
/** ProgramData layout: u32 tag (3), u64 slot, Option<Pubkey> upgrade authority. `null` = the program is immutable. */
export function upgradeAuthority(data: Uint8Array): string | null {
  const b = Buffer.from(data); if (b.length < 45 || b.readUInt32LE(0) !== 3) throw new Error("not a ProgramData account");
  return b[12] === 1 ? new PublicKey(b.subarray(13, 45)).toBase58() : null;
}

/** `initialize(committee: [Pubkey; 5], oracle: Pubkey)` — creates the pad; callable once, and only by the program's upgrade authority (the payer). */
export function initializeIx(program: PublicKey, payer: PublicKey, committee: PublicKey[], oracle: PublicKey): TransactionInstruction {
  if (committee.length !== 5) throw new Error("the committee has exactly five members");
  if (new Set(committee.map((k) => k.toBase58())).size !== 5) throw new Error("committee members must be five different wallets");
  const data = Buffer.concat([disc("global", "initialize"), ...committee.map((k) => k.toBuffer()), oracle.toBuffer()]);
  return new TransactionInstruction({ programId: program, data, keys: [
    { pubkey: padAddress(program), isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: program, isSigner: false, isWritable: false },
    { pubkey: programDataAddress(program), isSigner: false, isWritable: false },
  ] });
}

export interface PadState { committee: string[]; oracle: string; bump: number }
/** Decodes the `Pad` account: 8-byte discriminator, 5 × 32 committee, 32 oracle, 1 bump. */
export function decodePad(data: Uint8Array): PadState {
  const b = Buffer.from(data); if (b.length < 8 + 32 * 5 + 32 + 1) throw new Error("account is too small to be a Pad");
  if (!b.subarray(0, 8).equals(disc("account", "Pad"))) throw new Error("account is not a Pad (discriminator mismatch)");
  const key = (o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
  return { committee: [0, 1, 2, 3, 4].map((i) => key(8 + 32 * i)), oracle: key(8 + 160), bump: b[8 + 160 + 32] };
}
