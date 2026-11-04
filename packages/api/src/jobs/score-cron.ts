/**
 * Daily score oracle (§4). Runs at 00:05 UTC.
 *  1. pulls every settled launch of the last two seasons per seat
 *  2. computes survival, holder outcome, median peak, warnings (executed Warning/Fine decisions in the window)
 *  3. writes `scores` with the full inputs + their sha256, ranks seats, updates status (§5)
 *  4. emits zone_change events (the public daily leaderboard is this table)
 *  5. signs write_score on chain when the oracle is configured; the signature lands in scores.oracle_sig
 */
import { Pool } from "pg";
import { scoreSeats, PAD, type SeatRow } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { emit, season as seasonOf, tx, sha256 } from "../ctx.js";

export async function runScoreCron(ctx: Ctx, nowMs = ctx.now()) {
  const s = seasonOf(ctx, nowMs);
  const windowStart = new Date(s.start - PAD.SEASON_DAYS * 86_400_000); // this season + the previous one
  const { rows } = await ctx.pool.query(`
    with settled as (
      select l.seat, l.mint, l.ticker, l.launch_cap_usd,
             (select mcap_usd from launch_snapshots x where x.mint = l.mint and x.at <= l.launched_at + interval '30 days' order by x.at desc limit 1) as d30_cap,
             (select max(mcap_usd) from launch_snapshots x where x.mint = l.mint) as peak_cap,
             (select holders_at_or_above_entry_pct from launch_holder_outcomes h where h.mint = l.mint) as holder_pct
      from launches l where l.status in ('settled','banned') and l.launched_at >= $1
    ),
    warn as (select coalesce((payload->>'seat')::int, (regexp_match(subject, 'Seat (\\d+)'))[1]::int) as seat, count(*)::int as n
             from decisions where type in ('Warning','Fine') and status in ('executed','auto') and coalesce(decided_at, proposed_at) >= $1 group by 1)
    select st.seat, d.handle, d.deployer_wallet, st.since_season, st.notice_seasons, st.clean_seasons, st.status as prev_status,
           coalesce(100.0 * avg(case when se.d30_cap > se.launch_cap_usd then 1 else 0 end), 0) as survival_pct,
           coalesce(avg(se.holder_pct), 0) as holder_outcome_pct,
           coalesce(percentile_cont(0.5) within group (order by se.peak_cap / nullif(se.launch_cap_usd,0)), 0) as median_peak_x,
           coalesce(max(warn.n), 0) as warnings, false as banned,
           coalesce(jsonb_agg(to_jsonb(se) order by se.mint) filter (where se.mint is not null), '[]'::jsonb) as inputs
    from seats st left join developers d on d.id = st.developer_id left join settled se on se.seat = st.seat left join warn on warn.seat = st.seat
    where st.status <> 'vacant' group by st.seat, d.handle, d.deployer_wallet, st.since_season, st.notice_seasons, st.clean_seasons, st.status`, [windowStart]);

  const seatRows: SeatRow[] = rows.map((r) => ({
    seat: r.seat, developer: r.handle, wallet: r.deployer_wallet, since: `S${r.since_season}`, noticeSeasons: r.notice_seasons, cleanSeasons: r.clean_seasons,
    metrics: { survivalPct: Number(r.survival_pct), holderOutcomePct: Number(r.holder_outcome_pct), medianPeakX: Number(r.median_peak_x), warnings: Number(r.warnings), banned: Boolean(r.banned), launches: Array.isArray(r.inputs) ? r.inputs.length : 0 },
  }));
  const scored = scoreSeats(seatRows);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const hashes = new Map<number, string>();
  await tx(ctx.pool, async (q) => {
    for (const sc of scored) {
      const r = rows.find((x) => x.seat === sc.seat)!;
      const inputs = { seat: sc.seat, day, window_start: windowStart.toISOString(), launches: r.inputs, warnings: sc.metrics.warnings, banned: Boolean(r.banned), metrics: sc.metrics, weights: { survival: 0.3, holderOutcome: 0.35, peak: 0.2, conduct: 0.15 }, score: sc.score };
      const h = sha256(JSON.stringify(inputs)); hashes.set(sc.seat, h);
      await q.query(`insert into scores(seat, day, survival_pct, holder_outcome_pct, median_peak_x, warnings, score, rank, inputs, inputs_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (seat, day) do update set survival_pct=excluded.survival_pct, holder_outcome_pct=excluded.holder_outcome_pct, median_peak_x=excluded.median_peak_x, warnings=excluded.warnings, score=excluded.score, rank=excluded.rank, inputs=excluded.inputs, inputs_hash=excluded.inputs_hash`,
        [sc.seat, day, sc.metrics.survivalPct.toFixed(2), sc.metrics.holderOutcomePct.toFixed(2), sc.metrics.medianPeakX.toFixed(2), sc.metrics.warnings, sc.score, sc.rank, JSON.stringify(inputs), h]);
      const prevStatus: string = r.prev_status;
      if (prevStatus !== sc.status && prevStatus !== "vacant" && prevStatus !== "suspended") {
        await emit(q, "zone_change", { seat: sc.seat, payload: { from: prevStatus, to: sc.status, score: sc.score, window_opens: new Date(s.windowOpens).toISOString() } });
      }
      await q.query(`update seats set status = case when status in ('vacant','suspended') then status else $2 end, updated_at = now() where seat=$1`, [sc.seat, sc.status]);
    }
  });
  if (ctx.oracle.enabled) {
    for (const sc of scored) {
      const sig = await ctx.oracle.writeScore(sc.seat, sc.score, hashes.get(sc.seat)!);
      if (sig) await ctx.pool.query(`update scores set oracle_sig=$3 where seat=$1 and day=$2`, [sc.seat, day, sig]);
    }
  }
  return scored;
}

if (process.argv[1] && /score-cron\.(ts|js)$/.test(process.argv[1])) {
  const { makeCtx } = await import("../runtime.js");
  const ctx = makeCtx({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) });
  runScoreCron(ctx).then((s) => { console.log(`scored ${s.length} seats`); return ctx.pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
