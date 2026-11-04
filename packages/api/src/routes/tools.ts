/** Scanner, badge verification, waitlist, polls, the §12 ballot and the Helius webhook. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PAD, electionPhase } from "@twenty/shared";
import type { ScanReport } from "@twenty/shared";
import { scanDeployer, scanLaunch, creationsOf, ingest, knownFundingParents } from "@twenty/scanner";
import type { Ctx } from "../ctx.js";
import { emit, season as seasonOf } from "../ctx.js";
import { keyHash, timingEqual, ipHash, token, assertSafeWebhook, verifyWalletSignature, ballotMessage, nonceFresh, BASE58_RE } from "../security.js";
import { S } from "../schemas.js";
import { createHash } from "node:crypto";

export async function toolRoutes(app: FastifyInstance, ctx: Ctx) {
  const { pool, helius } = ctx;
  const env = (k: string, d: string) => process.env[k] ?? d;

  /* ── scanner (free for everyone: 6 req / min per IP, results cached 6 h) ── */
  app.get<{ Params: { address: string } }>("/v1/scan/:address", { schema: { params: S.address }, config: { rateLimit: { max: Number(env("SCAN_FREE_PER_MINUTE", "6")), timeWindow: "1 minute" } } }, async (req): Promise<ScanReport> => {
    const { address } = req.params;
    const { rows: cached } = await pool.query(`select report from scans where address=$1 and scanned_at > now() - interval '6 hours' order by scanned_at desc limit 1`, [address]);
    if (cached.length) return { ...(cached[0].report as ScanReport), cached: true };
    const sctx = { helius, knownFundingParents: await knownFundingParents(pool) };
    const asset = await helius.asset(address).catch(() => null);
    const report = asset?.token_info ? await scanLaunch(sctx, (await deployerOf(address)) ?? address, address, await launchedAt(address)) : await scanDeployer(sctx, address);
    await pool.query(`insert into scans(address, report) values ($1,$2)`, [address, report]);
    return report;
  });

  /* ── badge verification ─────────────────────────── */
  app.get<{ Params: { mint: string } }>("/v1/verify/:mint", { schema: { params: S.mint } }, async (req) => {
    const { rows } = await pool.query(`select l.mint, l.ticker, l.seat, l.status, d.handle from launches l join seats s on s.seat = l.seat join developers d on d.id = l.developer_id where l.mint=$1`, [req.params.mint]);
    return rows.length ? { verified: rows[0].status !== "banned", ...rows[0] } : { verified: false };
  });

  /* ── waitlist (site hero) ─────────────────────────────────── */
  app.post<{ Body: { contact: string; source: string } }>("/v1/waitlist", { schema: { body: S.waitlistBody }, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const contact = req.body.contact.trim();
    if (!/^(@?[A-Za-z0-9_]{3,32}|[^\s@]{1,64}@[^\s@]{1,63}\.[A-Za-z]{2,24})$/.test(contact)) return reply.code(400).send({ error: "handle or email required" });
    await pool.query(`insert into waitlist(contact, source, ip_hash) values ($1,$2,$3) on conflict (contact) do nothing`, [contact.toLowerCase(), req.body.source, ipHash(req.ip)]);
    const { rows: [{ n } = { n: 0 }] } = await pool.query(`select count(*)::int as n from waitlist`);
    reply.header("cache-control", "no-store");
    return { ok: true, position: n };
  });

  /* ── community polls (one vote per wallet-or-ip per poll; tallies public) ── */
  app.get<{ Params: { id: string } }>("/v1/polls/:id", { schema: { params: S.pollId } }, async (req) => {
    const { rows } = await pool.query(`select option, count(*)::int as votes from poll_votes where poll_id=$1 group by option order by option`, [req.params.id]);
    return { id: req.params.id, tally: Object.fromEntries(rows.map((r) => [r.option, r.votes])), total: rows.reduce((a, r) => a + r.votes, 0) };
  });
  app.post<{ Params: { id: string }; Body: { option: string; wallet?: string } }>("/v1/polls/:id/vote", { schema: { params: S.pollId, body: S.voteBody }, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const voter = req.body.wallet ? "w:" + req.body.wallet : "ip:" + ipHash(req.ip);
    await pool.query(`insert into poll_votes(poll_id, voter, option) values ($1,$2,$3) on conflict (poll_id, voter) do update set option = excluded.option, voted_at = now()`, [req.params.id, voter, req.body.option]);
    reply.header("cache-control", "no-store");
    return { ok: true };
  });

  /* ── §12 ballot: signed by the wallet, bound to season + candidate + nonce + time ── */
  app.post<{ Body: { wallet: string; candidate: string; signature: string; nonce: string; issued_at: string } }>("/v1/election/ballot", { schema: { body: S.ballotBody }, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = seasonOf(ctx); reply.header("cache-control", "no-store");
    if (electionPhase(s.day) !== "polls") return reply.code(409).send({ error: "polls are not open", phase: electionPhase(s.day) });
    const b = req.body; const candidate = b.candidate.replace(/^@/, "");
    if (!nonceFresh(b.issued_at, ctx.now())) return reply.code(400).send({ error: "ballot expired — sign a fresh message" });
    if (!verifyWalletSignature(b.wallet, ballotMessage(s.season, candidate, b.nonce, b.issued_at), b.signature)) return reply.code(401).send({ error: "signature does not match wallet" });
    const { rows: [snap] } = await pool.query(`select least(weight_pct, $3)::numeric(8,4) as weight_pct from election_snapshot where season=$1 and wallet=$2`, [s.season, b.wallet, PAD.ELECTION.voteCapPct]);
    if (!snap || Number(snap.weight_pct) < PAD.ELECTION.minHoldPct) return reply.code(403).send({ error: "wallet held no eligible position at the snapshot" });
    const { rows: [cand] } = await pool.query(`select c.developer_id from election_candidates c join developers d on d.id=c.developer_id where c.season=$1 and lower(d.handle)=lower($2) and c.confirmed_at is not null`, [s.season, candidate]);
    if (!cand) return reply.code(404).send({ error: "not a confirmed candidate" });
    const client = await pool.connect(); let moved = false;
    try {
      await client.query("begin");
      const used = await client.query(`insert into nonces(nonce, wallet, purpose) values ($1,$2,'ballot') on conflict do nothing`, [b.nonce, b.wallet]);
      if (!used.rowCount) { await client.query("rollback"); return reply.code(409).send({ error: "nonce already used" }); }
      const { rows: [prev] } = await client.query(`select developer_id from election_ballots where season=$1 and wallet=$2 for update`, [s.season, b.wallet]);
      moved = Boolean(prev);
      await client.query(`insert into election_ballots(season, wallet, developer_id, weight_pct, moved_from) values ($1,$2,$3,$4,$5)
        on conflict (season, wallet) do update set developer_id = excluded.developer_id, weight_pct = excluded.weight_pct, cast_at = now(), moved_from = $5`, [s.season, b.wallet, cand.developer_id, snap.weight_pct, prev?.developer_id ?? null]);
      await emit(client, "ballot", { seat: PAD.SEATS, payload: { season: s.season, candidate, moved, weight_pct: Number(snap.weight_pct) } });
      await client.query("commit");
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
    return { ok: true, season: s.season, candidate, weight_pct: Number(snap.weight_pct), moved };
  });

  /* ── indexer webhook (Helius enhanced webhook, CREATE events from the launchpads) ── */
  app.post("/v1/webhooks/helius", { bodyLimit: 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const secret = process.env.HELIUS_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: "webhook not configured" });
    if (!timingEqual(req.headers["authorization"], secret)) return reply.code(401).send({ error: "bad secret" });
    const body = req.body as Parameters<typeof creationsOf>[0];
    if (!Array.isArray(body) || body.length > 500) return reply.code(400).send({ error: "expected an array of up to 500 transactions" });
    const n = await ingest(pool, creationsOf(body));
    return { ingested: n };
  });

  /* ── helpers ──────────────────────────────────────────────── */
  async function deployerOf(mint: string) { const { rows } = await pool.query(`select d.deployer_wallet from launches l join developers d on d.id=l.developer_id where l.mint=$1`, [mint]); return rows[0]?.deployer_wallet as string | undefined; }
  async function launchedAt(mint: string) { const { rows } = await pool.query(`select launched_at from launches where mint=$1`, [mint]); return rows[0] ? new Date(rows[0].launched_at).getTime() : ctx.now() - 30 * 86_400_000; }
}
