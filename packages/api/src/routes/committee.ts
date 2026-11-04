/**
 * Committee routes (§2, §5, §7, §8, §11, §12): a member proposes a decision, members vote, 3 of 5 execute it in
 * one transaction. Every decision is public from the moment it is proposed. Bans become a `bans` row the
 * ban job executes (developer and linked wallets blocked, seat vacated, no payout); recalls mirror the on-chain vote.
 */
import type { FastifyInstance } from "fastify";
import { PAD, type Queryable } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { emit, ledger, lamports, tx, pad2, sha256, season as seasonOf } from "../ctx.js";
import { isBanned } from "../jobs/ban.js";
import { signed, committeeOf } from "../auth.js";
import { S } from "../schemas.js";

type Decision = { id: string; type: string; subject: string; outcome: string; payload: Record<string, unknown>; status: string };

export async function committeeRoutes(app: FastifyInstance, ctx: Ctx) {
  const { pool } = ctx;

  app.post<{ Body: { type: Decision["type"]; subject: string; outcome: string; payload?: Record<string, unknown>; evidence?: string[] } }>("/v1/committee/decisions", { schema: { body: S.decisionBody }, preHandler: signed("propose decision", ctx), config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const member = await committeeOf(pool, req.wallet!); if (!member) return reply.code(403).send({ error: "committee members only" });
    const payload = req.body.payload ?? {};
    const problem = await validatePayload(pool, req.body.type, payload);
    if (problem) return reply.code(400).send({ error: problem });
    const { rows: [d] } = await pool.query(`insert into decisions(type, subject, outcome, payload, status, proposed_by, votes_for, evidence) values ($1,$2,$3,$4,'proposed',$5,1,$6) returning id`, [req.body.type, req.body.subject, req.body.outcome, JSON.stringify(payload), member.wallet, req.body.evidence ? JSON.stringify(req.body.evidence) : null]);
    await pool.query(`insert into decision_votes(decision_id, wallet, vote) values ($1,$2,'for')`, [d.id, member.wallet]);
    await emit(pool, "decision_proposed", { seat: typeof payload.seat === "number" ? payload.seat : null, payload: { id: d.id, type: req.body.type, subject: req.body.subject, outcome: req.body.outcome, by: member.name, needs: PAD.COMMITTEE.threshold } });
    reply.header("cache-control", "no-store");
    return { id: d.id, status: "proposed", votes_for: 1, needs: PAD.COMMITTEE.threshold };
  });

  app.post<{ Params: { id: string }; Body: { vote: "for" | "against" } }>("/v1/committee/decisions/:id/vote", { schema: { params: S.uuid, body: S.committeeVoteBody }, preHandler: signed("committee vote", ctx), config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const member = await committeeOf(pool, req.wallet!); if (!member) return reply.code(403).send({ error: "committee members only" });
    const result = await tx(pool, async (c) => {
      const { rows: [d] } = await c.query<Decision>(`select id, type, subject, outcome, payload, status from decisions where id=$1 for update`, [req.params.id]);
      if (!d) return { code: 404, body: { error: "unknown decision" } };
      if (d.status !== "proposed") return { code: 409, body: { error: `decision is ${d.status}` } };
      await c.query(`insert into decision_votes(decision_id, wallet, vote) values ($1,$2,$3) on conflict (decision_id, wallet) do update set vote=excluded.vote, voted_at=now()`, [d.id, member.wallet, req.body.vote]);
      const { rows: [t] } = await c.query(`select count(*) filter (where vote='for')::int as f, count(*) filter (where vote='against')::int as a from decision_votes where decision_id=$1`, [d.id]);
      await c.query(`update decisions set votes_for=$2, votes_against=$3 where id=$1`, [d.id, t.f, t.a]);
      if (t.f >= PAD.COMMITTEE.threshold) { await execute(ctx, c, d); await c.query(`update decisions set status='executed', decided_at=now() where id=$1`, [d.id]); await emit(c, "decision", { seat: typeof d.payload.seat === "number" ? d.payload.seat : null, payload: { id: d.id, type: d.type, subject: d.subject, outcome: d.outcome, vote: `${t.f}–${t.a}` } }); return { code: 200, body: { id: d.id, status: "executed", votes_for: t.f, votes_against: t.a } }; }
      if (t.a >= PAD.COMMITTEE.threshold) { await c.query(`update decisions set status='rejected', decided_at=now() where id=$1`, [d.id]); await emit(c, "decision", { payload: { id: d.id, type: d.type, subject: d.subject, outcome: "rejected", vote: `${t.f}–${t.a}` } }); return { code: 200, body: { id: d.id, status: "rejected", votes_for: t.f, votes_against: t.a } }; }
      return { code: 200, body: { id: d.id, status: "proposed", votes_for: t.f, votes_against: t.a, needs: PAD.COMMITTEE.threshold } };
    });
    reply.header("cache-control", "no-store");
    return reply.code(result.code).send(result.body);
  });
}

async function validatePayload(q: Queryable, type: string, p: Record<string, unknown>): Promise<string | null> {
  const seat = p.seat, uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);
  const needSeat = ["Warning", "Fine", "Suspend", "Ban", "Seat"].includes(type);
  if (needSeat && !(Number.isInteger(seat) && (seat as number) >= 1 && (seat as number) <= PAD.SEATS)) return "payload.seat (1–20) required";
  if (type === "Fine" && !(typeof p.fine_sol === "number" && p.fine_sol > 0 && p.fine_sol <= 100)) return "payload.fine_sol (0–100) required";
  if (type === "Ban") {
    if (typeof p.reason !== "string" || p.reason.length < 5) return "payload.reason required";
    if (p.mint !== undefined) {
      if (typeof p.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.mint)) return "payload.mint invalid";
      const { rows } = await q.query(`select seat, status from launches where mint=$1`, [p.mint]); if (!rows.length || rows[0].seat !== seat) return "mint is not a launch of that seat"; if (rows[0].status === "banned") return "launch already banned";
    }
    const { rows: s } = await q.query(`select status from seats where seat=$1`, [seat]); if (!s.length || s[0].status === "vacant") return "seat is vacant";
  }
  if (type === "Suspend" && (typeof p.reason !== "string" || p.reason.length < 5)) return "payload.reason required";
  if ((type === "Bench" || type === "Rejected") && !uuid(p.application_id)) return "payload.application_id required";
  if (type === "Seat" && !uuid(p.application_id) && !uuid(p.developer_id)) return "payload.application_id or payload.developer_id required";
  if (type === "Challenge" && !(uuid(p.challenge_id) && (p.result === "replaced" || p.result === "kept"))) return "payload.challenge_id and payload.result (replaced|kept) required";
  if (type === "Bounty" && !(uuid(p.flag_id) && typeof p.upheld === "boolean")) return "payload.flag_id and payload.upheld required";
  if (type === "Recall" && !(typeof p.member === "string" && p.member.length > 0)) return "payload.member required";
  if (type === "Election" && !uuid(p.developer_id)) return "payload.developer_id required";
  return null;
}

/** The effect of a passed decision. Runs inside the vote's transaction. */
export async function execute(ctx: Ctx, c: Queryable, d: Decision) {
  const p = d.payload; const seat = p.seat as number | undefined;
  switch (d.type) {
    case "Warning": if (seat) await c.query(`update seats set season_flawed=true, updated_at=now() where seat=$1`, [seat]); return;
    case "Fine": {
      const sol = Number(p.fine_sol);
      if (seat) { await c.query(`update seats set season_flawed=true, updated_at=now() where seat=$1`, [seat]); await ledger(c, "treasury", `fine · seat ${pad2(seat)} · ${d.subject}`, lamports(sol)); }
      return;
    }
    case "Ban": {
      const { rows: [s] } = await c.query(`select developer_id from seats where seat=$1 and status <> 'vacant'`, [seat]);
      if (!s) throw new Error(`seat ${seat} is vacant`);
      await c.query(`insert into bans(seat, developer_id, mint, decision_id, reason, reason_hash) values ($1,$2,$3,$4,$5,$6)`, [seat, s.developer_id, p.mint ?? null, d.id, p.reason, sha256(String(p.reason))]);
      return; // the ban job blocks the wallets and vacates the seat (within minutes, same day)
    }
    case "Suspend": {
      await c.query(`update seats set status='suspended', suspended_until = now() + interval '${PAD.SUSPEND_DAYS} days', season_flawed=true, updated_at=now() where seat=$1 and status in ('seated','notice')`, [seat]);
      await emit(c, "seat_suspended", { seat, payload: { days: PAD.SUSPEND_DAYS, reason: p.reason, rule: "§7 abandoned launch" } });
      return;
    }
    case "Bench": {
      await c.query(`update applications set stage='public_review', public_review_ends = now() + interval '${PAD.PUBLIC_REVIEW_HOURS} hours', updated_at=now() where id=$1 and stage in ('onchain','interview')`, [p.application_id]);
      const { rows: [a] } = await c.query(`select ref, handle from applications where id=$1`, [p.application_id]);
      if (a) await emit(c, "public_review", { payload: { ref: a.ref, handle: a.handle, hours: PAD.PUBLIC_REVIEW_HOURS, bounty_sol: PAD.BOUNTY_SOL } });
      return;
    }
    case "Rejected": await c.query(`update applications set stage='rejected', updated_at=now() where id=$1`, [p.application_id]); return;
    case "Seat": {
      let devId = p.developer_id as string | undefined;
      if (!devId && p.application_id) {
        const { rows: [a] } = await c.query(`select handle, deployer_wallet, contact, developer_id from applications where id=$1`, [p.application_id]);
        if (!a) throw new Error("application vanished");
        devId = a.developer_id ?? (await c.query(`insert into developers(handle, deployer_wallet, contact) values ($1,$2,$3) on conflict (deployer_wallet) do update set handle=excluded.handle returning id`, [a.handle, a.deployer_wallet, a.contact])).rows[0].id;
        await c.query(`update applications set stage='seated', developer_id=$2, updated_at=now() where id=$1`, [p.application_id, devId]);
      }
      const { rows: [s] } = await c.query(`select status from seats where seat=$1`, [seat]);
      if (!s || s.status !== "vacant") throw new Error(`seat ${seat} is not vacant`);
      const season = seasonOf(ctx).season;
      const { rows: [dv] } = await c.query(`select deployer_wallet from developers where id=$1`, [devId]);
      if (dv && await isBanned(c, dv.deployer_wallet)) throw new Error("wallet is banned from the platform");
      await c.query(`update seats set developer_id=$2, status='seated', since_season=$3, notice_seasons=0, clean_seasons=0, season_flawed=false, suspended_until=null, updated_at=now() where seat=$1`, [seat, devId, season]);
      await emit(c, "seat_assigned", { seat, payload: { developer_id: devId } });
      return;
    }
    case "Challenge": {
      const { rows: [ch] } = await c.query(`select id, seat, challenger_id, status from challenges where id=$1`, [p.challenge_id]);
      if (!ch || ch.status !== "filed") throw new Error("challenge is not filed");
      await c.query(`update challenges set status='decided', outcome=$2, decided_at=now(), decision_id=$3 where id=$1`, [ch.id, p.result, d.id]);
      if (p.result === "replaced") {
        await c.query(`update seats set developer_id=$2, status='seated', notice_seasons=0, clean_seasons=0, season_flawed=false, suspended_until=null, updated_at=now() where seat=$1`, [ch.seat, ch.challenger_id]);
        await c.query(`update applications set stage='seated', updated_at=now() where developer_id=$1 and stage='bench'`, [ch.challenger_id]);
        await emit(c, "seat_replaced", { seat: ch.seat, payload: { by_challenge: ch.id } });
      }
      return;
    }
    case "Bounty": {
      const { rows: [f] } = await c.query(`select id, application_id, filer_wallet from review_flags where id=$1`, [p.flag_id]);
      if (!f) throw new Error("unknown flag");
      await c.query(`update review_flags set upheld=$2, decision_id=$3 where id=$1`, [f.id, p.upheld, d.id]);
      if (p.upheld) {
        await ledger(c, "treasury", `bounty · flag ${f.id}`, -lamports(PAD.BOUNTY_SOL), f.filer_wallet);
        await c.query(`update applications set stage='rejected', updated_at=now() where id=$1`, [f.application_id]);
        await emit(c, "bounty", { payload: { flag_id: f.id, sol: PAD.BOUNTY_SOL, application_id: f.application_id } });
      } else {
        const { rows: [{ n }] } = await c.query(`select count(*)::int as n from review_flags where filer_wallet=$1 and upheld = false`, [f.filer_wallet]);
        if (n >= PAD.FLAG_DISCARD_LOCK) await c.query(`insert into locked_wallets(wallet, reason) values ($1, $2) on conflict do nothing`, [f.filer_wallet, `${n} discarded flags (§11)`]);
      }
      return;
    }
    case "Recall": await c.query(`update committee_members set removed_at=now() where name=$1 or wallet=$1`, [p.member]); return;
    case "Election": {
      await c.query(`update election_candidates set confirmed_at=now() where season=$1 and developer_id=$2`, [seasonOf(ctx).season, p.developer_id]);
      return;
    }
    default: return;
  }
}
