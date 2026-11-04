/**
 * Wallet-signed requests (docs/API.md → "Signed requests").
 * The client signs `signedMessage(action, wallet, nonce, issued, sha256(canonicalJson(body)))` with the wallet's
 * ed25519 key and sends wallet / signature / nonce / issued as headers. The server rebuilds the text from what it
 * received, verifies the signature, burns the nonce and attaches `req.wallet`. Roles are looked up per request
 * from the tables (seat holders, bench developers, committee members) — nothing is cached in a session.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { signedMessage, canonicalJson, SIGNED_HEADERS, SIGNATURE_WINDOW_MS, type SignedAction, type Queryable } from "@twenty/shared";
import { verifyWalletSignature, BASE58_RE, SIG_RE } from "./security.js";
import { sha256 } from "./ctx.js";

declare module "fastify" { interface FastifyRequest { wallet?: string } }

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function signed(action: SignedAction, ctx: { pool: Queryable; now: () => number }): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const h = (k: string) => { const v = req.headers[k]; return typeof v === "string" ? v : ""; };
    const wallet = h(SIGNED_HEADERS.wallet), signature = h(SIGNED_HEADERS.signature), nonce = h(SIGNED_HEADERS.nonce), issued = h(SIGNED_HEADERS.issued);
    if (!BASE58_RE.test(wallet) || !SIG_RE.test(signature) || !NONCE_RE.test(nonce) || issued.length > 40) return reply.code(401).send({ error: "signed request required", headers: Object.values(SIGNED_HEADERS) });
    const t = Date.parse(issued);
    if (!Number.isFinite(t) || Math.abs(ctx.now() - t) > SIGNATURE_WINDOW_MS) return reply.code(401).send({ error: "signature expired — sign a fresh request" });
    const bodyHash = sha256(canonicalJson(req.body ?? {}));
    if (!verifyWalletSignature(wallet, signedMessage(action, wallet, nonce, issued, bodyHash), signature)) return reply.code(401).send({ error: "signature does not match wallet, action or body" });
    const used = await ctx.pool.query(`insert into nonces(nonce, wallet, purpose) values ($1,$2,$3) on conflict do nothing`, [nonce, wallet, action]);
    if (!used.rowCount) return reply.code(409).send({ error: "nonce already used" });
    req.wallet = wallet;
  };
}

export interface SeatHolder { seat: number; developer_id: string; handle: string; status: string; tenured: boolean; last_launch_at: Date | null }
export async function seatOf(q: Queryable, wallet: string): Promise<SeatHolder | null> {
  const { rows } = await q.query(`select s.seat, s.developer_id, d.handle, s.status, (s.clean_seasons >= $2) as tenured, s.last_launch_at
    from seats s join developers d on d.id = s.developer_id where d.deployer_wallet = $1 and s.status <> 'vacant'`, [wallet, 3]);
  return rows[0] ? rows[0] : null;
}
export async function benchOf(q: Queryable, wallet: string): Promise<{ id: string; ref: string; handle: string; developer_id: string; bench_rank: number | null } | null> {
  const { rows } = await q.query(`select id, ref, handle, developer_id, bench_rank from applications where deployer_wallet = $1 and stage = 'bench' and developer_id is not null`, [wallet]);
  return rows[0] ?? null;
}
export async function committeeOf(q: Queryable, wallet: string): Promise<{ name: string; wallet: string } | null> {
  const { rows } = await q.query(`select name, wallet from committee_members where wallet = $1 and removed_at is null`, [wallet]);
  return rows[0] ?? null;
}
export async function developerOf(q: Queryable, wallet: string): Promise<{ id: string; handle: string } | null> {
  const { rows } = await q.query(`select id, handle from developers where deployer_wallet = $1`, [wallet]);
  return rows[0] ?? null;
}
