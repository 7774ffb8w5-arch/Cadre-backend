/**
 * Merkle tree helpers (used for the People's Seat ballot root; there are no payouts any more).
 * Leaf = sha256(index_u32_le ‖ owner_pubkey_32 ‖ amount_lamports_u64_le). Pairs are sorted before
 * hashing so proofs are order-independent, matching the on-chain verifier in program/.
 */
import { createHash } from "node:crypto";

export interface PayoutLeaf { index: number; owner: string /* base58 */; lamports: bigint }
export interface PayoutTree { root: Buffer; leaves: Buffer[]; layers: Buffer[][]; total: bigint }

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`bad base58 char ${c}`); n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

export function leafHash(l: PayoutLeaf): Buffer {
  const idx = Buffer.alloc(4); idx.writeUInt32LE(l.index);
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(l.lamports);
  const owner = base58Decode(l.owner);
  if (owner.length !== 32) throw new Error(`owner ${l.owner} is not a 32-byte pubkey`);
  return sha256(Buffer.from([0x00]), idx, owner, amt); // 0x00 domain tag = leaf
}

function nodeHash(a: Buffer, b: Buffer): Buffer {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.from([0x01]), x, y); // 0x01 domain tag = node
}

export function buildTree(leaves: PayoutLeaf[]): PayoutTree {
  if (!leaves.length) throw new Error("empty tree");
  const hashes = leaves.map(leafHash);
  const layers: Buffer[][] = [hashes];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1]; const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], leaves: hashes, layers, total: leaves.reduce((a, l) => a + l.lamports, 0n) };
}

export function proofFor(tree: PayoutTree, index: number): Buffer[] {
  const proof: Buffer[] = []; let i = index;
  for (let d = 0; d < tree.layers.length - 1; d++) {
    const layer = tree.layers[d]; const sib = i ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(root: Buffer, leaf: PayoutLeaf, proof: Buffer[]): boolean {
  let h = leafHash(leaf);
  for (const p of proof) h = nodeHash(h, p);
  return h.equals(root);
}

/**
 * Pro-rata distribution of a pot over a holder snapshot. Disclosed wallets are excluded before
 * calling this. Dust (remainder from integer division) goes to the largest holder so the sum is exact.
 */
export function distribute(potLamports: bigint, holders: { owner: string; amount: bigint }[]): PayoutLeaf[] {
  const eligible = holders.filter((h) => h.amount > 0n);
  const supply = eligible.reduce((a, h) => a + h.amount, 0n);
  if (supply === 0n) return [];
  const leaves = eligible.map((h, index) => ({ index, owner: h.owner, lamports: (potLamports * h.amount) / supply }));
  const paid = leaves.reduce((a, l) => a + l.lamports, 0n);
  const dust = potLamports - paid;
  if (dust > 0n) { const top = leaves.reduce((a, b) => (b.lamports > a.lamports ? b : a)); top.lamports += dust; }
  return leaves;
}
