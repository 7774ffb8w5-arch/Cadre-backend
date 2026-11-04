/**
 * Season jobs (§5, §9, §10, §12).
 *   electionSnapshot  day 20, 00:00 UTC — every wallet's position across the season's launches → election_snapshot
 *   seasonClose       day 1, after the first score write of the new season — closes the previous season:
 *                       bottom two / < 40 → notice; notice at two consecutive closes → vacated (mark_replaced on chain)
 *                       tenure counters; seat-pool distribution by score (notice seats forfeit to the treasury)
 *                       People's Seat: the weighted winner takes seat 20, result + ballot root on chain
 */
import { PAD, poolShares, scoreSeats, buildTree, electionPhase, type SeatRow, type ScoredSeat } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { emit, autoDecision, ledger, season as seasonOf, tx, pad2, sha256 } from "../ctx.js";

export async function ensureElection(ctx: Ctx, seasonNo: number) {
  const len = PAD.SEASON_DAYS * 86_400_000, start = ctx.anchorMs + (seasonNo - 1) * len;
  const open = new Date(start + (PAD.ELECTION.nominationDays + PAD.ELECTION.campaignDays) * 86_400_000), close = new Date(start + len);
  await ctx.pool.query(`insert into elections(season, polls_open, polls_close) values ($1,$2,$3) on conflict (season) do nothing`, [seasonNo, open, close]);
}

/** §12 — the day-20 snapshot. Weight = Σ over the season's launches of the wallet's share of that token's supply (%). Insiders excluded per launch. */
export async function electionSnapshot(ctx: Ctx, seasonNo = seasonOf(ctx).season): Promise<{ wallets: number }> {
  await ensureElection(ctx, seasonNo);
  const { rows: [el] } = await ctx.pool.query(`select snapshot_at from elections where season=$1`, [seasonNo]);
  if (el?.snapshot_at) return { wallets: 0 };
  const len = PAD.SEASON_DAYS * 86_400_000, start = new Date(ctx.anchorMs + (seasonNo - 1) * len), end = new Date(ctx.anchorMs + seasonNo * len);
  const { rows: launches } = await ctx.pool.query<{ mint: string; supply: string | null; deployer_wallet: string }>(`select l.mint, l.supply, d.deployer_wallet from launches l join developers d on d.id = l.developer_id where l.launched_at >= $1 and l.launched_at < $2 and l.status <> 'banned'`, [start, end]);
  const weight = new Map<string, number>();
  for (const l of launches) {
    if (!l.supply || Number(l.supply) <= 0) continue;
    const { rows: insiders } = await ctx.pool.query(`select address from launch_wallets where mint=$1`, [l.mint]);
    const skip = new Set([l.deployer_wallet, ...insiders.map((w) => w.address)]);
    const { rows: pos } = await ctx.pool.query<{ owner: string; tokens: string }>(`select owner, tokens from holder_positions where mint=$1 and tokens > 0`, [l.mint]);
    for (const p of pos) if (!skip.has(p.owner)) weight.set(p.owner, (weight.get(p.owner) ?? 0) + (100 * Number(p.tokens)) / Number(l.supply));
  }
  await tx(ctx.pool, async (q) => {
    for (const [wallet, w] of weight) if (w >= PAD.ELECTION.minHoldPct) await q.query(`insert into election_snapshot(season, wallet, weight_pct) values ($1,$2,$3) on conflict do nothing`, [seasonNo, wallet, Math.min(9999.9999, w).toFixed(4)]);
    await q.query(`update elections set snapshot_at=now() where season=$1`, [seasonNo]);
    await emit(q, "election_snapshot", { payload: { season: seasonNo, wallets: weight.size, launches: launches.length } });
  });
  return { wallets: weight.size };
}

/** Closes `seasonNo` (normally the one that just ended). Idempotent: a 'Season' decision with the season number marks it done. */
export async function seasonClose(ctx: Ctx, seasonNo: number): Promise<{ closed: boolean; notice: number[]; vacated: number[]; pool: { seat: number; sol: number }[] }> {
  const { rows: done } = await ctx.pool.query(`select 1 from decisions where type='Season' and payload->>'close' = $1`, [String(seasonNo)]);
  if (done.length) return { closed: false, notice: [], vacated: [], pool: [] };
  const len = PAD.SEASON_DAYS * 86_400_000, end = new Date(ctx.anchorMs + seasonNo * len);
  /* the last score write of the season ranks the seats */
  const { rows: last } = await ctx.pool.query(`select distinct on (s.seat) s.seat, s.status, s.notice_seasons, s.clean_seasons, s.season_flawed, s.developer_id, sc.score, sc.survival_pct, sc.holder_outcome_pct, sc.median_peak_x, sc.warnings, coalesce(jsonb_array_length(sc.inputs->'launches'), 0) as launches, d.handle, d.deployer_wallet
    from seats s left join scores sc on sc.seat = s.seat and sc.day <= $1::date left join developers d on d.id = s.developer_id where s.status <> 'vacant' order by s.seat, sc.day desc nulls last`, [end]);
  const rows: SeatRow[] = last.map((r) => ({ seat: r.seat, developer: r.handle ?? "", wallet: r.deployer_wallet ?? "", since: "", noticeSeasons: r.notice_seasons, cleanSeasons: r.clean_seasons,
    metrics: { survivalPct: Number(r.survival_pct ?? 0), holderOutcomePct: Number(r.holder_outcome_pct ?? 0), medianPeakX: Number(r.median_peak_x ?? 0), warnings: Number(r.warnings ?? 0), launches: Number(r.launches ?? 0) } }));
  const scored: ScoredSeat[] = rows.length ? scoreSeats(rows) : [];
  const notice: number[] = [], vacated: number[] = [];
  const { rows: [pool] } = await ctx.pool.query(`select coalesce(sum(lamports),0)::bigint as l from ledger where account='seat_pool'`);
  const poolSol = Number(BigInt(pool.l)) / 1e9;
  const shares = scored.length ? poolShares(scored, poolSol) : Object.assign([], { forfeitedSol: 0 });
  await tx(ctx.pool, async (q) => {
    for (const s of scored) {
      const prev = last.find((r) => r.seat === s.seat)!;
      const onNotice = s.status === "notice";
      if (onNotice) notice.push(s.seat);
      const noticeSeasons = onNotice ? prev.notice_seasons + 1 : 0;
      const clean = onNotice || prev.season_flawed ? 0 : prev.clean_seasons + 1;
      if (onNotice && noticeSeasons >= 2) {
        vacated.push(s.seat);
        await q.query(`update seats set status='vacant', developer_id=null, notice_seasons=0, clean_seasons=0, season_flawed=false, suspended_until=null, updated_at=now() where seat=$1`, [s.seat]);
        await autoDecision(q, { type: "Seat", seat: s.seat, subject: `Seat ${pad2(s.seat)} · ${prev.handle}`, outcome: `on notice at two consecutive closes — seat vacated, refilled from the bench`, payload: { seat: s.seat, season: seasonNo, rule: "§5" } });
        await emit(q, "seat_vacated", { seat: s.seat, payload: { developer: prev.handle, season: seasonNo } });
      } else {
        await q.query(`update seats set status = case when status='suspended' then status else $2 end, notice_seasons=$3, clean_seasons=$4, season_flawed=false, updated_at=now() where seat=$1`, [s.seat, s.status, noticeSeasons, clean]);
        if (onNotice && prev.status !== "notice") await emit(q, "zone_change", { seat: s.seat, payload: { from: prev.status, to: "notice", score: s.score, at_close: true, season: seasonNo } });
        if (clean >= PAD.TENURE_SEASONS && prev.clean_seasons < PAD.TENURE_SEASONS) await emit(q, "tenured", { seat: s.seat, payload: { developer: prev.handle, seasons: clean } });
      }
    }
    /* §9 pool split, booked as ledger entries; the on-chain transfer follows the ledger */
    for (const sh of shares) { if (sh.sol > 0) await ledger(q, "seat_pool", `season ${seasonNo} share · seat ${pad2(sh.seat)}`, -BigInt(Math.round(sh.sol * 1e9)), null, null); }
    if (shares.forfeitedSol > 0) { await ledger(q, "seat_pool", `season ${seasonNo} notice forfeits → treasury`, -BigInt(Math.round(shares.forfeitedSol * 1e9))); await ledger(q, "treasury", `season ${seasonNo} notice forfeits`, BigInt(Math.round(shares.forfeitedSol * 1e9))); }
    await autoDecision(q, { type: "Season", subject: `Season ${seasonNo} close`, outcome: `${notice.length} on notice${vacated.length ? `, ${vacated.length} vacated` : ""} · ${poolSol.toFixed(2)} SOL seat pool distributed`, payload: { close: seasonNo, notice, vacated, pool: shares, forfeited_sol: shares.forfeitedSol } });
    await emit(q, "season_close", { payload: { season: seasonNo, notice, vacated, pool_sol: poolSol } });
  });
  for (const seat of vacated) { const sig = await ctx.oracle.markReplaced(seat); if (sig) await ctx.pool.query(`update decisions set tx=$2 where type='Seat' and payload->>'seat'=$1 and tx is null and status='auto'`, [String(seat), sig]); }
  await electionResult(ctx, seasonNo).catch((e) => ctx.log.error({ err: (e as Error).message }, "election result failed"));
  return { closed: true, notice, vacated, pool: shares };
}

/** §12 — the weighted winner takes seat 20 at the cut; the result and the ballots' Merkle root go on chain. */
export async function electionResult(ctx: Ctx, seasonNo: number) {
  const { rows: [el] } = await ctx.pool.query(`select season, result from elections where season=$1`, [seasonNo]);
  if (!el || el.result) return null;
  const { rows: tally } = await ctx.pool.query(`select b.developer_id, d.handle, d.deployer_wallet, sum(b.weight_pct)::float as w, count(*)::int as n from election_ballots b join developers d on d.id = b.developer_id join election_candidates c on c.season = b.season and c.developer_id = b.developer_id and c.confirmed_at is not null where b.season=$1 group by b.developer_id, d.handle, d.deployer_wallet order by w desc, n desc, d.handle`, [seasonNo]);
  if (!tally.length) { await ctx.pool.query(`update elections set result='no ballots' where season=$1`, [seasonNo]); return null; }
  const { rows: ballots } = await ctx.pool.query<{ wallet: string; weight_pct: string }>(`select wallet, weight_pct from election_ballots where season=$1 order by wallet`, [seasonNo]);
  const tree = buildTree(ballots.map((b, i) => ({ index: i, owner: b.wallet, lamports: BigInt(Math.round(Number(b.weight_pct) * 10_000)) })));
  const root = tree.root.toString("hex");
  const { rows: [tot] } = await ctx.pool.query(`select coalesce(sum(weight_pct),0)::float as w from election_snapshot where season=$1`, [seasonNo]);
  const turnoutBps = tot.w > 0 ? Math.min(10_000, Math.round((10_000 * ballots.reduce((a, b) => a + Number(b.weight_pct), 0)) / tot.w)) : 0;
  const win = tally[0];
  await tx(ctx.pool, async (q) => {
    await q.query(`update elections set result=$2, result_developer_id=$3, tally_root=$4 where season=$1`, [seasonNo, win.handle, win.developer_id, root]);
    const { rows: [s20] } = await q.query(`select developer_id, status from seats where seat=$1`, [PAD.SEATS]);
    if (s20.developer_id !== win.developer_id) {
      await q.query(`update seats set developer_id=$2, status='seated', since_season=$3, notice_seasons=0, clean_seasons=0, season_flawed=false, suspended_until=null, updated_at=now() where seat=$1`, [PAD.SEATS, win.developer_id, seasonNo + 1]);
      await q.query(`update applications set stage='seated', updated_at=now() where developer_id=$1 and stage='bench'`, [win.developer_id]);
    }
    await autoDecision(q, { type: "Election", seat: PAD.SEATS, subject: `Season ${seasonNo} · People's Seat`, outcome: `${win.handle} elected with ${win.w.toFixed(2)} % of the weighted vote (${win.n} wallets, turnout ${(turnoutBps / 100).toFixed(1)} %)`, payload: { season: seasonNo, winner: win.handle, developer_id: win.developer_id, tally_root: root, ballots: ballots.length, turnout_bps: turnoutBps, tally: tally.map((t) => ({ handle: t.handle, weight_pct: +t.w.toFixed(4), wallets: t.n })) } });
    await emit(q, "election_result", { seat: PAD.SEATS, payload: { season: seasonNo, winner: win.handle, weight_pct: +win.w.toFixed(2), wallets: win.n, tally_root: root } });
  });
  const sig = await ctx.oracle.writeElectionResult(seasonNo, win.deployer_wallet, root, ballots.length, turnoutBps);
  if (sig) await ctx.pool.query(`update elections set result_tx=$2 where season=$1`, [seasonNo, sig]);
  return { winner: win.handle, root, turnoutBps, tx: sig };
}

/** What the runner asks every minute. */
export function seasonJobsDue(ctx: Ctx): { closePrevious: number | null; snapshot: boolean } {
  const s = seasonOf(ctx);
  return { closePrevious: s.day === 1 && s.season > 1 ? s.season - 1 : null, snapshot: s.day === PAD.ELECTION.snapshotDay && electionPhase(s.day) === "campaign" };
}

export const inputsHash = (inputs: unknown) => sha256(JSON.stringify(inputs));
