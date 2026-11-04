/**
 * The clock of the pad (§1, §6, §7). Runs every 10 minutes and applies every rule that depends only on time:
 *   bookings   unpaid → expired · slot passed without a launch → missed (5 SOL fine + warning)
 *   launches   detected on chain for a booked slot but not registered → registered from chain data, disclosure due
 *              live → open after the 14-day lock · open → settled at day 30 with the holder outcome
 *   reports    reminder 24 h before due · missing after the 24 h grace → warning
 *   vetting    public review over without an upheld flag → bench
 *   committee  proposals older than 7 days → expired
 *   seats      30-day suspension over → seat restored
 *   hygiene    nonces > 1 day, scans > 30 days
 * Every step is idempotent; the lock in runner.ts stops two instances overlapping.
 */
import { PAD, holderOutcome, reportState } from "@twenty/shared";
import type { Ctx } from "../ctx.js";
import { emit, autoDecision, ledger, lamports, tx, pad2 } from "../ctx.js";
import { registerLaunch } from "../launches.js";
import { snapshotOne } from "./snapshots.js";

export interface LifecycleReport { expired: number; missed: number; soon: number; detected: number; opened: number; settled: number; reminded: number; warned: number; benched: number; expiredDecisions: number; suspended: number }

export async function runLifecycle(ctx: Ctx): Promise<LifecycleReport> {
  const r: LifecycleReport = { expired: 0, missed: 0, soon: 0, detected: 0, opened: 0, settled: 0, reminded: 0, warned: 0, benched: 0, expiredDecisions: 0, suspended: 0 };
  const nowMs = ctx.now(), now = new Date(nowMs);

  /* unpaid bookings free their slot */
  const ex = await ctx.pool.query(`update bookings set status='expired', cancelled_at=$1 where status='pending' and expires_at < $1 returning id, seat, slot_at`, [now]);
  r.expired = ex.rowCount ?? 0;
  for (const b of ex.rows) await emit(ctx.pool, "booking_expired", { seat: b.seat, payload: { slot_time: new Date(b.slot_at).toISOString() } });

  /* launches that happened on chain for a booked slot but were never registered */
  const { rows: due } = await ctx.pool.query(`select b.id, b.seat, b.slot_at, d.deployer_wallet, d.id as developer_id from bookings b join developers d on d.id = b.developer_id
    where b.status='confirmed' and b.slot_at <= $1 and b.slot_at > $1::timestamptz - interval '${PAD.MISSED_SLOT_GRACE_MIN + 30} minutes'`, [now]);
  for (const b of due) {
    const slotMs = new Date(b.slot_at).getTime();
    const { rows: found } = await ctx.pool.query(`select mint, created_at, signature, venue from deployer_index where deployer=$1 and created_at between $2 and $3 order by created_at limit 1`,
      [b.deployer_wallet, new Date(slotMs - PAD.LAUNCH_EARLY_TOLERANCE_MIN * 60_000), new Date(slotMs + PAD.LAUNCH_LATE_TOLERANCE_MIN * 60_000)]);
    if (!found.length) continue;
    const { rows: already } = await ctx.pool.query(`select 1 from launches where mint=$1`, [found[0].mint]);
    if (already.length) continue;
    try {
      await registerLaunch(ctx, { wallet: b.deployer_wallet, mint: found[0].mint, ticker: null, devAllocationPct: null, liquidity: "undisclosed", wallets: [], auto: true });
      r.detected++;
    } catch (e) { ctx.log.warn({ mint: found[0].mint, err: (e as Error).message }, "auto-registration failed"); }
  }

  r.soon = await slotReminders(ctx, now);

  /* missed slots: confirmed, grace over, no launch */
  /* missed slots: confirmed, grace over, no launch */
  const missed = await ctx.pool.query(`select b.id, b.seat, b.slot_at, b.fee_lamports from bookings b where b.status='confirmed' and b.slot_at < $1::timestamptz - interval '${PAD.MISSED_SLOT_GRACE_MIN} minutes'
    and not exists (select 1 from launches l where l.booking_id = b.id)`, [now]);
  for (const b of missed.rows) { await penalizeMissedSlot(ctx, b.id, b.seat, new Date(b.slot_at), "no launch inside the slot"); r.missed++; }

  /* lock over → open; day 30 → settled with the holder outcome */
  const op = await ctx.pool.query(`update launches set status='open' where status='live' and launched_at <= $1::timestamptz - interval '${PAD.LOCK_DAYS} days' returning mint, seat, ticker`, [now]);
  r.opened = op.rowCount ?? 0;
  for (const l of op.rows) await emit(ctx.pool, "launch_open", { seat: l.seat, mint: l.mint, payload: { ticker: l.ticker, day: PAD.LOCK_DAYS } });
  const { rows: toSettle } = await ctx.pool.query(`select mint, seat, ticker, developer_id, decimals from launches where status in ('live','open') and launched_at <= $1::timestamptz - interval '${PAD.SETTLE_DAYS} days'`, [now]);
  for (const l of toSettle) { await settleLaunch(ctx, l.mint); r.settled++; }

  /* reports */
  const rem = await ctx.pool.query(`update reports r set reminded_at=$1 from launches l where l.mint = r.mint and r.filed_at is null and r.reminded_at is null and r.due_at <= $1::timestamptz + interval '24 hours' returning r.mint, r.which, r.due_at, l.seat, l.ticker`, [now]);
  r.reminded = rem.rowCount ?? 0;
  for (const x of rem.rows) await emit(ctx.pool, "report_due", { seat: x.seat, mint: x.mint, payload: { which: x.which, ticker: x.ticker, due_at: new Date(x.due_at).toISOString() } });
  const { rows: missing } = await ctx.pool.query(`select r.mint, r.which, r.due_at, l.seat, l.ticker from reports r join launches l on l.mint = r.mint where r.filed_at is null and r.warned_at is null and r.due_at + interval '${PAD.REPORT_GRACE_HOURS} hours' < $1`, [now]);
  for (const x of missing) {
    if (reportState(null, new Date(x.due_at).getTime(), nowMs) !== "missing") continue;
    await tx(ctx.pool, async (q) => {
      await q.query(`update reports set warned_at=$3 where mint=$1 and which=$2`, [x.mint, x.which, now]);
      await autoDecision(q, { type: "Warning", seat: x.seat, subject: `Seat ${pad2(x.seat)} · $${x.ticker} day-${x.which} report`, outcome: `missing ${PAD.REPORT_GRACE_HOURS} h after the deadline — warning (−25 conduct)`, payload: { seat: x.seat, mint: x.mint, which: x.which, rule: "§7 report > 24 h late" } });
    });
    r.warned++;
  }
  /* undisclosed auto-registered launches: 24 h to complete the disclosure, then a warning */
  const { rows: undisclosed } = await ctx.pool.query(`select mint, seat, ticker from launches where liquidity='undisclosed' and launched_at < $1::timestamptz - interval '24 hours' and (precheck->>'disclosure_warned') is null`, [now]);
  for (const l of undisclosed) {
    await tx(ctx.pool, async (q) => {
      await q.query(`update launches set precheck = coalesce(precheck,'{}'::jsonb) || '{"disclosure_warned":true}'::jsonb where mint=$1`, [l.mint]);
      await autoDecision(q, { type: "Warning", seat: l.seat, subject: `Seat ${pad2(l.seat)} · $${l.ticker} disclosure`, outcome: "launch registered from chain data; disclosure still missing after 24 h — warning", payload: { seat: l.seat, mint: l.mint, rule: "§6 disclosure before launch" } });
    });
    r.warned++;
  }

  /* public review over → bench (unless a flag was upheld, which rejects the application when the decision executes) */
  const { rows: reviewed } = await ctx.pool.query(`select id, ref, handle, deployer_wallet, contact, precheck from applications where stage='public_review' and public_review_ends <= $1`, [now]);
  for (const a of reviewed) {
    const { rows: pending } = await ctx.pool.query(`select 1 from review_flags where application_id=$1 and upheld is null`, [a.id]);
    if (pending.length) continue; // the committee still has flags to rule on; the review stays open
    await tx(ctx.pool, async (q) => {
      const { rows: [dev] } = await q.query(`insert into developers(handle, deployer_wallet, contact) values ($1,$2,$3) on conflict (deployer_wallet) do update set handle = excluded.handle returning id`, [a.handle, a.deployer_wallet, a.contact]);
      const score = Number(a.precheck?.score ?? 0);
      const { rows: [{ n }] } = await q.query(`select count(*)::int as n from applications where stage='bench' and coalesce((precheck->>'score')::numeric, 0) > $1`, [score]);
      await q.query(`update applications set stage='bench', developer_id=$2, bench_rank=$3, updated_at=now() where id=$1`, [a.id, dev.id, n + 1]);
      await q.query(`update applications set bench_rank = bench_rank + 1 where stage='bench' and id <> $1 and bench_rank >= $2`, [a.id, n + 1]);
      await autoDecision(q, { type: "Season", subject: `Bench · ${a.handle}`, outcome: `public review closed without an upheld flag — on the bench at #${n + 1} (pre-check ${score})`, payload: { application_id: a.id, ref: a.ref } });
      await emit(q, "bench_joined", { payload: { handle: a.handle, ref: a.ref, rank: n + 1, score } });
    });
    r.benched++;
  }

  /* committee proposals expire after 7 days */
  const exd = await ctx.pool.query(`update decisions set status='expired', decided_at=$1 where status='proposed' and proposed_at < $1::timestamptz - interval '7 days' returning id, subject`, [now]);
  r.expiredDecisions = exd.rowCount ?? 0;

  /* §7 the 30-day suspension after an abandoned launch is over → the seat is back */
  const un = await ctx.pool.query(`update seats set status='seated', suspended_until=null, updated_at=now() where status='suspended' and suspended_until is not null and suspended_until <= $1 and developer_id is not null returning seat`, [now]);
  r.suspended = un.rowCount ?? 0;
  for (const s of un.rows) await emit(ctx.pool, "seat_restored", { seat: s.seat, payload: {} });

  await ctx.pool.query(`delete from nonces where used_at < $1::timestamptz - interval '1 day'`, [now]);
  await ctx.pool.query(`delete from scans where scanned_at < $1::timestamptz - interval '30 days'`, [now]);
  return r;
}

/** "Launches in 15 minutes": one reminder per confirmed slot, for the seat and its watchers (web push, Telegram, webhooks). Runs every minute in the runner. */
export async function slotReminders(ctx: Ctx, now = new Date(ctx.now())): Promise<number> {
  const soon = await ctx.pool.query(`update bookings b set soon_at = $1 from developers d where d.id = b.developer_id and b.status='confirmed' and b.soon_at is null and b.slot_at > $1 and b.slot_at <= $1::timestamptz + interval '20 minutes' returning b.seat, b.slot_at, d.handle`, [now]);
  for (const b of soon.rows) await emit(ctx.pool, "slot_soon", { seat: b.seat, payload: { slot_time: new Date(b.slot_at).toISOString(), developer: b.handle, minutes: Math.max(1, Math.round((new Date(b.slot_at).getTime() - now.getTime()) / 60_000)) } });
  return soon.rowCount ?? 0;
}

/** §7 — missed slot: fee forfeited (already split), 5 SOL fine, warning on record. */
export async function penalizeMissedSlot(ctx: Ctx, bookingId: string, seat: number, slotAt: Date, why: string) {
  await tx(ctx.pool, async (q) => {
    const upd = await q.query(`update bookings set status='missed' where id=$1 and status in ('confirmed','pending') returning id`, [bookingId]);
    if (!upd.rowCount) return;
    await q.query(`update seats set missed_slots = missed_slots + 1, updated_at = now() where seat=$1`, [seat]);
    await ledger(q, "treasury", `fine · missed slot · seat ${pad2(seat)}`, lamports(PAD.MISSED_SLOT_FINE_SOL), null, null);
    await autoDecision(q, { type: "Fine", seat, subject: `Seat ${pad2(seat)} · slot ${slotAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, outcome: `${why} — slot fee forfeited, ${PAD.MISSED_SLOT_FINE_SOL} SOL fine, warning on record`, payload: { seat, booking_id: bookingId, fine_sol: PAD.MISSED_SLOT_FINE_SOL, rule: "§7 missed slot" } });
    await emit(q, "slot_missed", { seat, payload: { slot_time: slotAt.toISOString(), fine_sol: PAD.MISSED_SLOT_FINE_SOL, why } });
  });
}

/** Day 30: the holder outcome from cost-basis positions (insiders excluded) at the latest price; the launch is settled. */
export async function settleLaunch(ctx: Ctx, mint: string) {
  await snapshotOne(ctx, mint).catch(() => null);
  const { rows: [l] } = await ctx.pool.query(`select l.mint, l.seat, l.ticker, l.decimals, d.deployer_wallet from launches l join developers d on d.id = l.developer_id where l.mint=$1`, [mint]);
  if (!l) return;
  const { rows: [snap] } = await ctx.pool.query(`select price_usd, mcap_usd from launch_snapshots where mint=$1 order by at desc limit 1`, [mint]);
  const { rows: insiders } = await ctx.pool.query(`select address from launch_wallets where mint=$1`, [mint]);
  const excluded = new Set([l.deployer_wallet, ...insiders.map((w) => w.address)]);
  const { rows: pos } = await ctx.pool.query<{ owner: string; tokens: string; cost_usd: string }>(`select owner, tokens, cost_usd from holder_positions where mint=$1 and tokens > 0`, [mint]);
  const outcome = holderOutcome(pos.filter((p) => !excluded.has(p.owner)).map((p) => ({ tokens: BigInt(p.tokens), costUsd: Number(p.cost_usd) })), Number(snap?.price_usd ?? 0), l.decimals ?? 0);
  await tx(ctx.pool, async (q) => {
    await q.query(`insert into launch_holder_outcomes(mint, holders_at_or_above_entry_pct, holders_counted, price_usd) values ($1,$2,$3,$4) on conflict (mint) do update set holders_at_or_above_entry_pct=excluded.holders_at_or_above_entry_pct, holders_counted=excluded.holders_counted, price_usd=excluded.price_usd, computed_at=now()`, [mint, outcome.pct, outcome.counted, snap?.price_usd ?? null]);
    await q.query(`update launches set status='settled', settled_at=now() where mint=$1 and status in ('live','open')`, [mint]);
    await emit(q, "launch_settled", { seat: l.seat, mint, payload: { ticker: l.ticker, holder_outcome_pct: outcome.pct, holders_counted: outcome.counted, mcap_usd: Number(snap?.mcap_usd ?? 0) } });
  });
}
