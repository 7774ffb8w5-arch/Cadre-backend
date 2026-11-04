/** Public, unauthenticated feeds. Everything the site renders comes from here. */
import type { FastifyInstance } from "fastify";
import { PAD, WEIGHTS, electionPhase } from "@twenty/shared";
import type { PadFeed, SeatFeedRow, SlotFeedRow, LaunchFeedRow } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { season as seasonOf } from "../ctx.js";
import { S, B58 } from "../schemas.js";
import { ballotMessage, token } from "../security.js";

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  const { pool } = ctx;

  app.get("/v1/pad", async (): Promise<PadFeed> => {
    const s = seasonOf(ctx);
    const { rows: [l] } = await pool.query(`select
        coalesce(sum(case when account='seat_pool' then lamports end),0)::bigint as pool,
        coalesce(sum(case when account='treasury' then lamports end),0)::bigint as treasury from ledger`);
    const { rows: notice } = await pool.query(`select seat from seats where status='notice' order by seat`);
    const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from launches where launched_at >= to_timestamp($1/1000.0)`, [s.start]);
    const { rows: bench } = await pool.query(`select handle from applications where stage='bench' order by bench_rank limit 12`);
    const sol = (x: bigint | string) => Number(BigInt(x)) / 1e9;
    return {
      season: s.season, day: s.day, season_ends: new Date(s.end).toISOString(), replacement_window_opens: new Date(s.windowOpens).toISOString(),
      seats: PAD.SEATS, on_notice: notice.map((r) => r.seat), seat_pool_sol: sol(l.pool), treasury_sol: sol(l.treasury),
      slot_fee_sol: PAD.SLOT_FEE_SOL, fee_split: PAD.FEE_SPLIT, score_weights: WEIGHTS,
      launches_this_season: n, season_ceiling: PAD.SEASON_CEILING, bench: bench.map((b) => b.handle), treasury_wallet: ctx.treasury ?? null, generated_at: new Date().toISOString(),
    };
  });

  app.get("/v1/seats", async (): Promise<SeatFeedRow[]> => {
    const { rows } = await pool.query(`
      with latest as (select distinct on (seat) * from scores order by seat, day desc),
           hist as (select seat, array_agg(score order by day) as score_30d from scores where day > current_date - 30 group by seat),
           live as (select distinct on (seat) seat, ticker from launches where status='live' order by seat, launched_at desc),
           nb as (select seat, min(slot_at) as next_slot from bookings where slot_at > now() and status in ('pending','confirmed') group by seat),
           lt as (select seat, count(*)::int as total, count(*) filter (where launched_at >= $1)::int as season from launches where status <> 'banned' group by seat)
      select s.seat, d.handle as developer, d.deployer_wallet as wallet, l.score, l.rank, s.status, (s.clean_seasons >= $2) as tenured,
             l.survival_pct, l.holder_outcome_pct, l.median_peak_x, l.warnings, coalesce(lt.total,0) as total, coalesce(lt.season,0) as season,
             live.ticker as live_launch, nb.next_slot, coalesce(hist.score_30d, '{}') as score_30d
      from seats s left join developers d on d.id = s.developer_id left join latest l on l.seat = s.seat left join hist on hist.seat = s.seat
      left join live on live.seat = s.seat left join nb on nb.seat = s.seat left join lt on lt.seat = s.seat order by s.seat`, [new Date(seasonOf(ctx).start), PAD.TENURE_SEASONS]);
    return rows.map((r) => ({
      seat: r.seat, developer: r.developer ?? "vacant", wallet: r.wallet ?? "", score: r.score ?? 0, rank: r.rank ?? 0, status: r.status, tenured: r.tenured,
      survival_pct: Number(r.survival_pct ?? 0), holder_outcome_pct: Number(r.holder_outcome_pct ?? 0), median_peak_x: Number(r.median_peak_x ?? 0), warnings: r.warnings ?? 0,
      launches_total: r.total, launches_season: r.season, live_launch: r.live_launch, next_slot: r.next_slot ? new Date(r.next_slot).toISOString() : null, pool_share_sol: 0, score_30d: r.score_30d,
    }));
  });

  app.get<{ Params: { seat: number } }>("/v1/seats/:seat/inputs", { schema: { params: S.seat } }, async (req, reply) => {
    const { rows } = await pool.query(`select seat, day, inputs, inputs_hash, oracle_sig, score, rank from scores where seat=$1 order by day desc limit 1`, [req.params.seat]);
    if (!rows.length) return reply.code(404).send({ error: "no score yet" });
    return rows[0];
  });

  app.get("/v1/slots", async (): Promise<SlotFeedRow[]> => {
    // announced launches only: there are no fixed hours, so there is no grid of open slots
    const t = ctx.now();
    const { rows } = await pool.query(`select slot_at, seat from bookings where slot_at >= to_timestamp($1/1000.0) and slot_at < to_timestamp($2/1000.0) and status in ('pending','confirmed','launched') order by slot_at`, [t - 86_400_000, t + 30 * 86_400_000]);
    return rows.map((r) => { const ts = new Date(r.slot_at).getTime(); return { time: new Date(ts).toISOString(), seat: r.seat as number, status: ts < t ? "launched" : "booked", fee_sol: PAD.SLOT_FEE_SOL } as SlotFeedRow; });
  });

  app.get("/v1/launches", async (): Promise<LaunchFeedRow[]> => {
    const { rows } = await pool.query(`
      with snap as (select distinct on (mint) mint, mcap_usd, holders from launch_snapshots order by mint, at desc),
           peak as (select mint, max(mcap_usd) as peak from launch_snapshots group by mint),
           rep as (select mint, jsonb_object_agg('d'||which, report_state(filed_at, due_at)) as reports from reports group by mint),
           w as (select mint, jsonb_agg(jsonb_build_object('label',label,'address',address,'pct',pct)) as wallets from launch_wallets group by mint)
      select l.*, d.handle as developer, snap.mcap_usd, snap.holders, peak.peak, rep.reports, w.wallets, bn.executed_at, bn.reason as ban_reason
      from launches l join developers d on d.id = l.developer_id left join snap on snap.mint = l.mint left join peak on peak.mint = l.mint left join rep on rep.mint = l.mint left join w on w.mint = l.mint left join bans bn on bn.id = l.ban_id
      order by l.launched_at desc limit 100`);
    return rows.map((r) => {
      const day = Math.floor((ctx.now() - new Date(r.launched_at).getTime()) / 86_400_000);
      return {
        ticker: r.ticker, mint: r.mint, seat: r.seat, developer: r.developer, launched_at: new Date(r.launched_at).toISOString(), day,
        launch_cap_usd: Number(r.launch_cap_usd ?? 0), mcap_usd: Number(r.mcap_usd ?? 0), multiple: r.launch_cap_usd ? +(Number(r.mcap_usd ?? 0) / Number(r.launch_cap_usd)).toFixed(2) : 0,
        peak_multiple: r.launch_cap_usd ? +(Number(r.peak ?? 0) / Number(r.launch_cap_usd)).toFixed(2) : 0, holders: r.holders ?? 0, dev_allocation_pct: Number(r.dev_allocation_pct), liquidity: r.liquidity, status: r.status,
        reports: { d7: r.reports?.d7 ?? "due", d30: r.reports?.d30 ?? "due" }, disclosed_wallets: r.wallets ?? [],
        banned: r.executed_at ? { id: r.ban_id, day: Math.floor((new Date(r.executed_at).getTime() - new Date(r.launched_at).getTime()) / 86_400_000), reason: r.ban_reason } : null,
      };
    });
  });

  app.get<{ Params: { mint: string } }>("/v1/launches/:mint/snapshots", { schema: { params: S.mint } }, async (req) => {
    const { rows } = await pool.query(`select at, mcap_usd::float as mcap_usd, holders, price_usd::float as price_usd, liquidity_usd::float as liquidity_usd from launch_snapshots where mint=$1 order by at limit 400`, [req.params.mint]);
    return rows;
  });

  app.get<{ Querystring: { limit: number; type?: string; seat?: number } }>("/v1/log", { schema: { querystring: S.logQuery } }, async (req) => {
    const { limit, type, seat } = req.query;
    const { rows } = await pool.query(`select id, at, type, seat, mint, payload from events where ($1::text is null or type = $1) and ($2::int is null or seat = $2) order by id desc limit $3`, [type ?? null, seat ?? null, limit]);
    return rows;
  });

  /* the public record: committee decisions and automatic penalties */
  app.get<{ Querystring: { limit: number; status?: string } }>("/v1/decisions", { schema: { querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, status: { type: "string", enum: ["proposed", "executed", "rejected", "expired", "auto"] } } } } }, async (req) => {
    const { rows } = await pool.query(`select id, proposed_at, decided_at, type, subject, outcome, status, votes_for, votes_against, payload - 'contact' as payload, tx from decisions where ($1::text is null or status=$1) order by proposed_at desc limit $2`, [req.query.status ?? null, req.query.limit]);
    return rows;
  });

  /* challenges with their holder signal */
  app.get<{ Querystring: { seat?: number } }>("/v1/challenges", { schema: { querystring: { type: "object", additionalProperties: false, properties: { seat: { type: "integer", minimum: 1, maximum: PAD.SEATS } } } } }, async (req) => {
    const { rows } = await pool.query(`select c.id, c.seat, d.handle as challenger, c.kind, c.status, c.filed_at, c.decided_at, c.outcome,
        coalesce(sum(v.weight_pct) filter (where v.vote='keep'),0)::float as keep_pct, coalesce(sum(v.weight_pct) filter (where v.vote='replace'),0)::float as replace_pct, count(v.wallet)::int as votes
      from challenges c join developers d on d.id = c.challenger_id left join holder_votes v on v.challenge_id = c.id
      where ($1::int is null or c.seat=$1) and c.status in ('open','filed','decided') and c.filed_at > now() - interval '60 days' group by c.id, d.handle order by c.filed_at desc limit 100`, [req.query.seat ?? null]);
    return rows;
  });

  /* applications in public review (flags welcome) and the bench — handles and refs only, never contacts */
  app.get<{ Querystring: { stage?: string } }>("/v1/applications", { schema: { querystring: { type: "object", additionalProperties: false, properties: { stage: { type: "string", enum: ["public_review", "bench"] } } } } }, async (req) => {
    const { rows } = await pool.query(`select a.ref, a.handle, a.stage, a.public_review_ends, a.bench_rank, (a.precheck->>'score')::int as precheck_score, (a.precheck->>'flags')::int as precheck_flags, cardinality(a.mints) as launches,
        (select count(*)::int from review_flags f where f.application_id = a.id and f.upheld is null) as open_flags
      from applications a where a.stage = coalesce($1, a.stage) and a.stage in ('public_review','bench') order by a.stage, a.bench_rank nulls last, a.created_at`, [req.query.stage ?? null]);
    return rows;
  });
  app.get<{ Params: { ref: string } }>("/v1/applications/:ref", { schema: { params: S.ref } }, async (req, reply) => {
    const { rows } = await pool.query(`select ref, handle, stage, public_review_ends, bench_rank, precheck, created_at, updated_at from applications where ref=$1`, [req.params.ref]);
    return rows[0] ?? reply.code(404).send({ error: "unknown application" });
  });

  /* the public ban list: who, when, why. A ban pays nothing out and is permanent. */
  app.get("/v1/bans", async () => {
    const { rows } = await pool.query(`select b.id, b.seat, d.handle as developer, b.mint, b.reason, b.executed_at, b.decision_id, (select count(*)::int from banned_wallets w where w.ban_id = b.id) as wallets
      from bans b join developers d on d.id = b.developer_id where b.executed_at is not null order by b.executed_at desc limit 200`);
    return rows;
  });

  /* what a wallet is on the pad: seat, bench application, committee, open bookings, ballot */
  app.get<{ Params: { wallet: string } }>("/v1/wallets/:wallet", { schema: { params: S.wallet } }, async (req, reply) => {
    const w = req.params.wallet; const s = seasonOf(ctx); reply.header("cache-control", "no-store");
    const { rows: seat } = await pool.query(`select s.seat, s.status, d.handle, s.suspended_until, s.last_launch_at, (s.clean_seasons >= $2) as tenured from seats s join developers d on d.id = s.developer_id where d.deployer_wallet=$1 and s.status <> 'vacant'`, [w, PAD.TENURE_SEASONS]);
    const { rows: app_ } = await pool.query(`select ref, handle, stage, bench_rank, public_review_ends from applications where deployer_wallet=$1 order by created_at desc limit 1`, [w]);
    const { rows: cm } = await pool.query(`select name from committee_members where wallet=$1 and removed_at is null`, [w]);
    const { rows: bookings } = await pool.query(`select b.id, b.slot_at, b.status, b.memo, b.expires_at from bookings b join developers d on d.id = b.developer_id where d.deployer_wallet=$1 and b.slot_at > now() - interval '1 day' and b.status in ('pending','confirmed') order by b.slot_at`, [w]);
    const { rows: launches } = await pool.query(`select l.mint, l.ticker, l.status, l.launched_at from launches l join developers d on d.id = l.developer_id where d.deployer_wallet=$1 order by l.launched_at desc limit 20`, [w]);
    const { rows: ballot } = await pool.query(`select d.handle as candidate, b.weight_pct::float as weight_pct, b.cast_at from election_ballots b join developers d on d.id = b.developer_id where b.season=$1 and b.wallet=$2`, [s.season, w]);
    const { rows: elig } = await pool.query(`select least(weight_pct, $3)::float as weight_pct from election_snapshot where season=$1 and wallet=$2`, [s.season, w, PAD.ELECTION.voteCapPct]);
    const { rows: locked } = await pool.query(`select 1 from locked_wallets where wallet=$1`, [w]);
    const { rows: banned } = await pool.query(`select 1 from banned_wallets where address=$1`, [w]);
    return { wallet: w, seat: seat[0] ?? null, application: app_[0] ?? null, committee: cm[0]?.name ?? null, bookings, launches, election: { season: s.season, phase: electionPhase(s.day), weight_pct: elig[0]?.weight_pct ?? 0, ballot: ballot[0] ?? null }, locked: locked.length > 0, banned: banned.length > 0 };
  });

  /* §12 election feeds */
  app.get("/v1/election", async () => {
    const s = seasonOf(ctx); const phase = electionPhase(s.day);
    const { rows: [el] } = await pool.query(`select season, snapshot_slot, snapshot_at, polls_open, polls_close, result, tally_root, result_tx from elections where season=$1`, [s.season]);
    const { rows: cands } = await pool.query(`
      select d.handle, c.statement, c.confirmed_at is not null as confirmed, coalesce(sum(b.weight_pct),0)::float as weight_pct, count(b.wallet)::int as ballots
      from election_candidates c join developers d on d.id = c.developer_id left join election_ballots b on b.season = c.season and b.developer_id = c.developer_id
      where c.season=$1 group by d.handle, c.statement, c.confirmed_at order by weight_pct desc, d.handle`, [s.season]);
    const { rows: [tot = { weight_pct: 0, ballots: 0 }] } = await pool.query(`select coalesce(sum(weight_pct),0)::float as weight_pct, count(*)::int as ballots from election_ballots where season=$1`, [s.season]);
    return {
      season: s.season, day: s.day, phase, nominations_until_day: PAD.ELECTION.nominationDays, campaign_until_day: PAD.ELECTION.nominationDays + PAD.ELECTION.campaignDays,
      snapshot_day: PAD.ELECTION.snapshotDay, vote_cap_pct: PAD.ELECTION.voteCapPct, snapshot: el ? { slot: el.snapshot_slot, at: el.snapshot_at } : null,
      polls: el ? { open: el.polls_open, close: el.polls_close } : null, result: el?.result ?? null, tally_root: el?.tally_root ?? null, result_tx: el?.result_tx ?? null,
      turnout: { weight_pct: tot.weight_pct, ballots: tot.ballots }, candidates: cands, generated_at: new Date().toISOString(),
    };
  });
  app.get<{ Params: { wallet: string } }>("/v1/election/eligibility/:wallet", { schema: { params: S.wallet } }, async (req, reply) => {
    const s = seasonOf(ctx);
    const { rows } = await pool.query(`select least(weight_pct, $3)::float as weight_pct from election_snapshot where season=$1 and wallet=$2`, [s.season, req.params.wallet, PAD.ELECTION.voteCapPct]);
    const { rows: cur } = await pool.query(`select d.handle, b.cast_at from election_ballots b join developers d on d.id=b.developer_id where b.season=$1 and b.wallet=$2`, [s.season, req.params.wallet]);
    reply.header("cache-control", "no-store");
    return { season: s.season, eligible: rows.length > 0 && rows[0].weight_pct >= PAD.ELECTION.minHoldPct, weight_pct: rows[0]?.weight_pct ?? 0, ballot: cur[0] ?? null, nonce: token(18), message_template: ballotMessage(s.season, "<candidate>", "<nonce>", "<issued_at>") };
  });

  /* the public status page: component states, 90-day uptime bars, incidents */
  app.get("/v1/health", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=15");
    const { rows: comps } = await pool.query(`select component, state, latency_ms, detail, since, updated_at from health_state order by component`);
    const { rows: daily } = await pool.query(`select day::text as day, component, ok, degraded, total from health_daily where day >= current_date - 89 order by day`);
    const { rows: inc } = await pool.query(`select id, component, title, started_at, resolved_at from incidents where started_at > now() - interval '30 days' order by started_at desc limit 20`);
    const stale = !comps.length || comps.some((c) => Date.now() - new Date(c.updated_at).getTime() > 5 * 60_000);
    const order = { down: 3, degraded: 2, operational: 1, off: 0 } as Record<string, number>;
    const worst = comps.reduce((a, c) => Math.max(a, order[c.state] ?? 0), 0);
    return { overall: stale ? "unknown" : worst >= 3 ? "outage" : worst === 2 ? "degraded" : "operational", components: comps, daily, incidents: inc, generated_at: new Date().toISOString() };
  });

  /* transparency: what ran when, how fresh the data is */
  app.get("/v1/status", async () => {
    const { rows: jobs } = await pool.query(`select distinct on (name) name, started_at, finished_at, ok from job_runs order by name, started_at desc`);
    const { rows: [snap] } = await pool.query(`select max(at) as last from launch_snapshots`);
    const { rows: [score] } = await pool.query(`select max(day) as last from scores`);
    const { rows: [idx] } = await pool.query(`select count(*)::int as n, max(created_at) as last from deployer_index`);
    const { rows: [ev] } = await pool.query(`select count(*)::int as undelivered from events where delivered_at is null`);
    const s = seasonOf(ctx);
    return { season: s.season, day: s.day, oracle: ctx.oracle.enabled ? ctx.oracle.pubkey : null, jobs, last_snapshot: snap.last, last_score_day: score.last, deployer_index: { rows: idx.n, newest: idx.last }, events_undelivered: ev.undelivered, generated_at: new Date().toISOString() };
  });
}
