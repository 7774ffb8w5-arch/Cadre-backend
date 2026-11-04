/**
 * Developer routes — everything a seat holder, a bench developer or a holder does, each a wallet-signed request
 * (auth.ts). The rulebook sections are quoted at each step; nothing here is reachable without a signature.
 */
import type { FastifyInstance } from "fastify";
import { PAD, slotBookable, reportState, electionPhase } from "@twenty/shared";
import { scanLaunch, knownFundingParents } from "@twenty/scanner";
import type { Ctx } from "../ctx.js";
import { emit, autoDecision, splitSlotFee, lamports, memoToken, season as seasonOf, tx, pad2 } from "../ctx.js";
import { signed, seatOf, benchOf, developerOf } from "../auth.js";
import { registerLaunch, disclose, HttpError } from "../launches.js";
import { penalizeMissedSlot } from "../jobs/lifecycle.js";
import { ensureElection } from "../jobs/season.js";
import { S } from "../schemas.js";
import { randomBytes } from "node:crypto";

export async function devRoutes(app: FastifyInstance, ctx: Ctx) {
  const { pool } = ctx;
  const noStore = { onSend: async (_r: unknown, reply: { header: (k: string, v: string) => unknown }) => { reply.header("cache-control", "no-store"); } };

  /* ── §1 book a slot ──────────────────────────────────────────────────────── */
  app.post<{ Body: { slot_at: string } }>("/v1/slots/book", { schema: { body: S.bookBody }, preHandler: signed("book slot", ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const seat = await seatOf(pool, req.wallet!); if (!seat) return reply.code(403).send({ error: "wallet holds no seat" });
    if (seat.status === "suspended") return reply.code(403).send({ error: "seat is suspended (30 days after an abandoned launch)" });
    const slotMs = Date.parse(req.body.slot_at); const nowMs = ctx.now();
    if (!Number.isFinite(slotMs) || slotMs % 1000 !== 0) return reply.code(400).send({ error: "slot_at must be a valid time on a whole minute" });
    const { rows: open } = await pool.query(`select 1 from bookings where seat=$1 and status in ('pending','confirmed') and slot_at > $2`, [seat.seat, new Date(nowMs)]);
    const liveDay = seat.last_launch_at ? Math.floor((nowMs - new Date(seat.last_launch_at).getTime()) / 86_400_000) : null;
    const { rows: near } = await pool.query(`select slot_at from bookings where status in ('pending','confirmed','launched') and slot_at > $1 and slot_at < $2 and slot_at <> $3`, [new Date(slotMs - PAD.MIN_SLOT_GAP_MINUTES * 60_000), new Date(slotMs + PAD.MIN_SLOT_GAP_MINUTES * 60_000), new Date(slotMs)]);
    const ok = slotBookable(slotMs, nowMs, { liveLaunchDay: liveDay, hasBooking: open.length > 0 }, near.map((r) => new Date(r.slot_at).getTime()));
    if (!ok.ok) return reply.code(409).send({ error: ok.why });
    const s = seasonOf(ctx, nowMs);
    const { rows: [{ n: seasonCount }] } = await pool.query(`select (select count(*) from launches where launched_at >= $1 and status <> 'banned') + (select count(*) from bookings where status in ('pending','confirmed') and slot_at >= $1 and slot_at < $2) as n`, [new Date(s.start), new Date(s.end)]);
    if (Number(seasonCount) >= PAD.SEASON_CEILING && slotMs < s.end) return reply.code(409).send({ error: `season ceiling of ${PAD.SEASON_CEILING} launches reached` });
    const { rows: [{ n: mine }] } = await pool.query(`select (select count(*) from launches where seat=$3 and launched_at >= $1 and launched_at < $2) + (select count(*) from bookings where seat=$3 and status in ('pending','confirmed','launched') and slot_at >= $1 and slot_at < $2) as n`, [new Date(s.start), new Date(s.end), seat.seat]);
    const allowance = PAD.SLOTS_PER_SEASON + (seat.tenured ? PAD.TENURE_EXTRA_SLOTS : 0);
    if (Number(mine) >= allowance && slotMs < s.end) return reply.code(409).send({ error: `seat allowance of ${allowance} slots this season used` });
    const { rows: taken } = await pool.query(`select seat from bookings where slot_at=$1 and status in ('pending','confirmed','launched')`, [new Date(slotMs)]);
    if (taken.length) return reply.code(409).send({ error: "slot already booked" });
    const memo = memoToken("SLOT"), fee = lamports(PAD.SLOT_FEE_SOL), expires = new Date(nowMs + PAD.BOOKING_PAY_WINDOW_MIN * 60_000);
    const bypass = process.env.BOOKING_FEE_BYPASS === "1";
    const id = await tx(pool, async (c) => {
      const { rows: [b] } = await c.query(`insert into bookings(slot_at, seat, developer_id, status, memo, fee_lamports, expires_at, confirmed_at, fee_tx) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [new Date(slotMs), seat.seat, seat.developer_id, bypass ? "confirmed" : "pending", memo, fee.toString(), expires, bypass ? new Date(nowMs) : null, bypass ? "bypass" : null]);
      if (bypass) { await splitSlotFee(c, fee, seat.seat, null);
        await emit(c, "slot_booked", { seat: seat.seat, payload: { slot_time: new Date(slotMs).toISOString().slice(0, 16).replace("T", " "), developer: seat.handle, fee_sol: PAD.SLOT_FEE_SOL } }); }
      else await emit(c, "slot_pending", { seat: seat.seat, payload: { slot_time: new Date(slotMs).toISOString(), expires_at: expires.toISOString() } });
      return b.id as string;
    });
    reply.header("cache-control", "no-store");
    return { booking_id: id, seat: seat.seat, slot_at: new Date(slotMs).toISOString(), status: bypass ? "confirmed" : "pending", memo, amount_sol: PAD.SLOT_FEE_SOL, pay_to: ctx.treasury, expires_at: expires.toISOString(),
      instructions: bypass ? "confirmed (fee bypass)" : `Send ${PAD.SLOT_FEE_SOL} SOL from the seat wallet to ${ctx.treasury} with memo ${memo} within ${PAD.BOOKING_PAY_WINDOW_MIN} minutes. The slot shows on the public calendar as soon as the transfer confirms.` };
  });

  /* ── §7 cancel: with 24 h notice nothing but the fee; closer than that it is a missed slot ── */
  app.post<{ Params: { id: string } }>("/v1/slots/:id/cancel", { schema: { params: S.uuid }, preHandler: signed("cancel slot", ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const seat = await seatOf(pool, req.wallet!); if (!seat) return reply.code(403).send({ error: "wallet holds no seat" });
    const { rows: [b] } = await pool.query(`select id, seat, slot_at, status from bookings where id=$1 and seat=$2 and status in ('pending','confirmed')`, [req.params.id, seat.seat]);
    if (!b) return reply.code(404).send({ error: "no open booking with that id for this seat" });
    const noticeH = (new Date(b.slot_at).getTime() - ctx.now()) / 3_600_000;
    if (b.status === "confirmed" && noticeH < PAD.CANCEL_NOTICE_HOURS) { await penalizeMissedSlot(ctx, b.id, b.seat, new Date(b.slot_at), `cancelled ${noticeH.toFixed(1)} h before the slot`); return { ok: true, status: "missed", fine_sol: PAD.MISSED_SLOT_FINE_SOL, warning: true }; }
    await tx(pool, async (c) => {
      await c.query(`update bookings set status='cancelled', cancelled_at=now(), cancel_notice_hours=$2 where id=$1`, [b.id, noticeH.toFixed(2)]);
      await emit(c, "slot_cancelled", { seat: b.seat, payload: { slot_time: new Date(b.slot_at).toISOString(), notice_hours: +noticeH.toFixed(1), fee_kept: b.status === "confirmed" } });
    });
    reply.header("cache-control", "no-store");
    return { ok: true, status: "cancelled", notice_hours: +noticeH.toFixed(1), note: b.status === "confirmed" ? "the slot fee is not refunded (§9); no fine, no warning" : "unpaid booking released" };
  });

  /* ── §6 register the launch at the slot; the chain is checked ───────────── */
  app.post<{ Body: { mint: string; ticker?: string; dev_allocation_pct: number; liquidity: string; wallets: { label: string; address: string; pct: number }[] } }>("/v1/launches", { schema: { body: S.launchBody }, preHandler: signed("register launch", ctx), config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    try { reply.header("cache-control", "no-store"); return await registerLaunch(ctx, { wallet: req.wallet!, mint: req.body.mint, ticker: req.body.ticker ?? null, devAllocationPct: req.body.dev_allocation_pct ?? null, liquidity: req.body.liquidity, wallets: req.body.wallets ?? [] }); }
    catch (e) { if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.message }); throw e; }
  });
  app.patch<{ Params: { mint: string }; Body: { ticker?: string; dev_allocation_pct?: number; liquidity?: string; wallets?: { label: string; address: string; pct: number }[] } }>("/v1/launches/:mint", { schema: { params: S.mint, body: S.discloseBody }, preHandler: signed("register launch", ctx), config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    try { reply.header("cache-control", "no-store"); return await disclose(ctx, { wallet: req.wallet!, mint: req.params.mint, devAllocationPct: req.body.dev_allocation_pct, liquidity: req.body.liquidity, wallets: req.body.wallets, ticker: req.body.ticker }); }
    catch (e) { if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.message }); throw e; }
  });

  /* ── §6 reports: day 7 and day 30, late by more than 24 h = warning ──────── */
  app.post<{ Params: { mint: string; which: number }; Body: { url: string } }>("/v1/launches/:mint/reports/:which", { schema: { params: S.reportParams, body: S.reportBody }, preHandler: signed("file report", ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { mint, which } = req.params;
    const { rows: [l] } = await pool.query(`select l.seat, l.ticker, l.status from launches l join developers d on d.id = l.developer_id where l.mint=$1 and d.deployer_wallet=$2`, [mint, req.wallet]);
    if (!l) return reply.code(404).send({ error: "no such launch for this wallet" });
    const { rows: [r] } = await pool.query(`select due_at, filed_at, warned_at from reports where mint=$1 and which=$2`, [mint, which]);
    if (!r) return reply.code(404).send({ error: "no such report" });
    if (r.filed_at) return reply.code(409).send({ error: "report already filed", filed_at: r.filed_at });
    const nowMs = ctx.now(); const state = reportState(nowMs, new Date(r.due_at).getTime(), nowMs);
    await tx(pool, async (c) => {
      await c.query(`update reports set filed_at=$3, url=$4 where mint=$1 and which=$2`, [mint, which, new Date(nowMs), req.body.url]);
      if (state === "late" && !r.warned_at) {
        await c.query(`update reports set warned_at=$3 where mint=$1 and which=$2`, [mint, which, new Date(nowMs)]);
        await autoDecision(c, { type: "Warning", seat: l.seat, subject: `Seat ${pad2(l.seat)} · $${l.ticker} day-${which} report`, outcome: `filed ${((nowMs - new Date(r.due_at).getTime()) / 3_600_000).toFixed(0)} h after the deadline — warning (−25 conduct)`, payload: { seat: l.seat, mint, which, rule: "§7 report > 24 h late" } });
      }
      await emit(c, "report_filed", { seat: l.seat, mint, payload: { which, ticker: l.ticker, state, url: req.body.url } });
    });
    reply.header("cache-control", "no-store");
    return { ok: true, mint, which, state, filed_at: new Date(nowMs).toISOString() };
  });

  /* ── §2 apply: ≥ 3 prior launches, the four checks over each one ─────────── */
  app.post<{ Body: { handle: string; mints: string[]; contact: string } }>("/v1/apply", { schema: { body: S.applyBody }, preHandler: signed("apply", ctx), config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const wallet = req.wallet!;
    const { rows: locked } = await pool.query(`select reason from locked_wallets where wallet=$1`, [wallet]); if (locked.length) return reply.code(403).send({ error: "wallet is locked: " + locked[0].reason });
    const { rows: seated } = await pool.query(`select 1 from seats s join developers d on d.id = s.developer_id where d.deployer_wallet=$1 and s.status <> 'vacant'`, [wallet]); if (seated.length) return reply.code(409).send({ error: "wallet already holds a seat" });
    const { rows: openApp } = await pool.query(`select ref, stage from applications where deployer_wallet=$1 and stage in ('onchain','interview','public_review','bench')`, [wallet]); if (openApp.length) return reply.code(409).send({ error: `an application is already open (${openApp[0].ref}, ${openApp[0].stage})` });
    const handle = req.body.handle.replace(/^@/, "");
    const scanCtx = { helius: ctx.helius, knownFundingParents: await knownFundingParents(pool).catch(() => new Map()) };
    const results = [] as { mint: string; flags: number; score: number; checks: unknown[]; error?: string }[];
    for (const mint of req.body.mints.slice(0, 5)) {
      try { const r = await scanLaunch(scanCtx, wallet, mint, ctx.now() - 30 * 86_400_000); results.push({ mint, flags: r.flags, score: r.score, checks: r.checks }); }
      catch (e) { results.push({ mint, flags: 0, score: 0, checks: [], error: (e as Error).message }); }
    }
    const worst = [...results].sort((a, b) => b.flags - a.flags || a.score - b.score)[0];
    const precheck = { score: Math.round(results.reduce((a, r) => a + r.score, 0) / Math.max(1, results.length)), flags: results.reduce((a, r) => a + r.flags, 0), launches: results, scanned_at: new Date(ctx.now()).toISOString() };
    const ref = "TW-A-" + randomBytes(3).toString("hex").toUpperCase();
    await tx(pool, async (c) => {
      await c.query(`insert into applications(ref, handle, deployer_wallet, contact, mints, worst_launch, precheck) values ($1,$2,$3,$4,$5,$6,$7)`, [ref, handle, wallet, req.body.contact.trim(), req.body.mints, worst?.mint ?? null, JSON.stringify(precheck)]);
      await emit(c, "application", { payload: { ref, handle, launches: req.body.mints.length, precheck_score: precheck.score, flags: precheck.flags } });
    });
    reply.header("cache-control", "no-store");
    return { ref, handle, stage: "onchain", precheck: { score: precheck.score, flags: precheck.flags, launches: results.map((r) => ({ mint: r.mint, flags: r.flags, score: r.score })) }, next: "committee interview — identity verified privately, never stored" };
  });

  /* ── §11 public-review flags ─────────────────────────────────────────────── */
  app.post<{ Params: { ref: string }; Body: { claim: string; evidence: string[] } }>("/v1/applications/:ref/flags", { schema: { params: S.ref, body: S.flagBody }, preHandler: signed("flag application", ctx), config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const wallet = req.wallet!;
    const { rows: locked } = await pool.query(`select 1 from locked_wallets where wallet=$1`, [wallet]); if (locked.length) return reply.code(403).send({ error: "wallet is locked after three discarded flags" });
    const { rows: [a] } = await pool.query(`select id, handle, stage, public_review_ends, deployer_wallet from applications where ref=$1`, [req.params.ref]);
    if (!a) return reply.code(404).send({ error: "unknown application" });
    if (a.stage !== "public_review" || new Date(a.public_review_ends).getTime() < ctx.now()) return reply.code(409).send({ error: "public review is not open for this application" });
    if (a.deployer_wallet === wallet) return reply.code(409).send({ error: "an applicant cannot flag their own application" });
    const { rows: dup } = await pool.query(`select 1 from review_flags where application_id=$1 and filer_wallet=$2`, [a.id, wallet]); if (dup.length) return reply.code(409).send({ error: "one flag per wallet per application" });
    const { rows: [f] } = await pool.query(`insert into review_flags(application_id, filer_wallet, evidence, claim) values ($1,$2,$3,$4) returning id`, [a.id, wallet, req.body.evidence, req.body.claim]);
    await emit(pool, "flag_filed", { payload: { ref: req.params.ref, handle: a.handle, flag_id: f.id, evidence: req.body.evidence.length } });
    reply.header("cache-control", "no-store");
    return { ok: true, flag_id: f.id, bounty_sol: PAD.BOUNTY_SOL, note: "the committee rules on it before the public window closes; an upheld flag pays the bounty, a discarded one counts toward the three-flag lock" };
  });

  /* ── §5 challenges from the bench ────────────────────────────────────────── */
  app.post<{ Body: { seat: number; kind: "signal" | "filed"; evidence?: string } }>("/v1/challenges", { schema: { body: S.challengeBody }, preHandler: signed("challenge", ctx), config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const bench = await benchOf(pool, req.wallet!); if (!bench) return reply.code(403).send({ error: "only bench developers can challenge" });
    const { rows: [target] } = await pool.query(`select s.seat, s.status, d.handle from seats s left join developers d on d.id = s.developer_id where s.seat=$1`, [req.body.seat]);
    if (!target || target.status === "vacant") return reply.code(409).send({ error: "seat is vacant" });
    const s = seasonOf(ctx);
    const { rows: existing } = await pool.query(`select id, kind, status from challenges where seat=$1 and challenger_id=$2 and status in ('open','filed')`, [req.body.seat, bench.developer_id]);
    if (req.body.kind === "signal") {
      if (existing.length) return reply.code(409).send({ error: `already ${existing[0].status} (${existing[0].kind})` });
      const { rows: [c] } = await pool.query(`insert into challenges(seat, challenger_id, kind, status) values ($1,$2,'signal','open') returning id`, [req.body.seat, bench.developer_id]);
      await emit(pool, "challenge", { seat: req.body.seat, payload: { kind: "signaled", challenger: bench.handle, incumbent: target.handle } });
      return { id: c.id, kind: "signal", status: "open" };
    }
    if (!s.windowOpen) return reply.code(409).send({ error: "challenges are filed inside the replacement window (last 72 h of the season)", window_opens: new Date(s.windowOpens).toISOString() });
    const { rows: cooldown } = await pool.query(`select 1 from challenges where seat=$1 and challenger_id=$2 and kind='filed' and outcome='kept' and decided_at > now() - interval '${PAD.CHALLENGE_COOLDOWN_DAYS} days'`, [req.body.seat, bench.developer_id]);
    if (cooldown.length) return reply.code(409).send({ error: `${PAD.CHALLENGE_COOLDOWN_DAYS}-day cooldown on this seat after a lost challenge` });
    if (existing.some((e) => e.kind === "filed")) return reply.code(409).send({ error: `already ${existing.find((e) => e.kind === "filed")!.status}` });
    const evidence = String(req.body.evidence ?? "").trim();
    if (evidence.length < 20) return reply.code(400).send({ error: "a filed challenge needs public evidence (at least a sentence and a link)" });
    const { rows: [c] } = await pool.query(`insert into challenges(seat, challenger_id, kind, status, evidence) values ($1,$2,'filed','filed',$3) returning id`, [req.body.seat, bench.developer_id, evidence]);
    await pool.query(`update challenges set status='withdrawn', outcome='withdrawn', decided_at=now() where seat=$1 and challenger_id=$2 and kind='signal' and status='open'`, [req.body.seat, bench.developer_id]);
    await emit(pool, "challenge", { seat: req.body.seat, payload: { kind: "filed", challenger: bench.handle, incumbent: target.handle, decides_within_hours: PAD.COMMITTEE.banWindowHours } });
    reply.header("cache-control", "no-store");
    return { id: c.id, kind: "filed", status: "filed", note: `Filing is free. The evidence is public; the committee decides within ${PAD.COMMITTEE.banWindowHours} h. If the challenge fails, the same seat is closed to you for ${PAD.CHALLENGE_COOLDOWN_DAYS} days.` };
  });

  /* ── §5 holder signal on a filed challenge, weighted by position in the incumbent's last three launches ── */
  app.post<{ Params: { id: string }; Body: { vote: "keep" | "replace" } }>("/v1/challenges/:id/holder-vote", { schema: { params: S.uuid, body: S.holderVoteBody }, preHandler: signed("holder vote", ctx), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { rows: [c] } = await pool.query(`select id, seat, status from challenges where id=$1`, [req.params.id]);
    if (!c || c.status !== "filed") return reply.code(409).send({ error: "holder signal is open on filed, undecided challenges only" });
    const { rows: last3 } = await pool.query(`select mint, supply from launches where seat=$1 and status <> 'banned' order by launched_at desc limit 3`, [c.seat]);
    let weight = 0, best: { mint: string; w: number } | null = null;
    for (const l of last3) {
      if (!l.supply) continue;
      const { rows: [p] } = await pool.query(`select tokens from holder_positions where mint=$1 and owner=$2`, [l.mint, req.wallet]);
      const w = p ? Math.min(PAD.ELECTION.voteCapPct, (100 * Number(p.tokens)) / Number(l.supply)) : 0;
      weight += w; if (!best || w > best.w) best = { mint: l.mint, w };
    }
    if (!(weight > 0)) return reply.code(403).send({ error: "wallet holds none of this seat's last three launches" });
    await pool.query(`insert into holder_votes(challenge_id, wallet, vote, weight_pct, mint) values ($1,$2,$3,$4,$5) on conflict (challenge_id, wallet) do update set vote=excluded.vote, weight_pct=excluded.weight_pct, voted_at=now()`, [c.id, req.wallet, req.body.vote, weight.toFixed(4), best!.mint]);
    reply.header("cache-control", "no-store");
    return { ok: true, vote: req.body.vote, weight_pct: +weight.toFixed(4) };
  });

  /* ── §12 candidacy from the bench during nominations ─────────────────────── */
  app.post<{ Body: { statement?: string } }>("/v1/election/candidacy", { schema: { body: S.candidacyBody }, preHandler: signed("declare candidacy", ctx), config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const bench = await benchOf(pool, req.wallet!); if (!bench) return reply.code(403).send({ error: "only bench developers can stand for the People's Seat" });
    const s = seasonOf(ctx); if (electionPhase(s.day) !== "nominations") return reply.code(409).send({ error: "nominations are days 1–10 of the season" });
    await ensureElection(ctx, s.season);
    await pool.query(`insert into election_candidates(season, developer_id, statement) values ($1,$2,$3) on conflict (season, developer_id) do update set statement=excluded.statement`, [s.season, bench.developer_id, req.body.statement ?? null]);
    await emit(pool, "candidacy", { seat: PAD.SEATS, payload: { season: s.season, handle: bench.handle } });
    reply.header("cache-control", "no-store");
    return { ok: true, season: s.season, handle: bench.handle, confirmed: false, note: "the committee confirms eligibility only; the holders decide" };
  });

  /* convenience for the site: the developer behind a wallet (handle only) */
  app.get<{ Params: { wallet: string } }>("/v1/developers/:wallet", { schema: { params: S.wallet } }, async (req, reply) => {
    const d = await developerOf(pool, req.params.wallet); return d ? { handle: d.handle } : reply.code(404).send({ error: "unknown wallet" });
  });
  void noStore;
}
