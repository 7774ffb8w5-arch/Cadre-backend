/**
 * The scheduler: one process, every job on its own cadence, each run under a Postgres advisory lock so a second
 * replica never overlaps, every run written to `job_runs` (what /v1/status shows). Start with
 *   node packages/api/dist/jobs/runner.js            (compose: service `jobs`)
 *
 *   reminders        every minute   "launches in 15 min" for confirmed slots
 *   lifecycle        every 10 min   bookings, launches, reports, vetting, suspensions, hygiene
 *   snapshots-fresh  every 30 min   launches in their first 48 h
 *   snapshots        every 6 h      every live/open launch
 *   scores           daily 00:05    the §4 write (+ on-chain)
 *   season           day 1 00:15    closes the previous season (after the first score write)
 *   election-snap    day 20 00:02   the §12 snapshot
 *   health          every 1 min    status probes → /v1/health (the public status page), incidents
 *   bans             every 5 min    executes passed ban decisions (wallet block, seat vacated)
 *   indexer          every 15 min   resolves funding parents for the deployer index
 *   billing          every 30 s     SOL slot fees
 */
import { Pool } from "pg";
import { resolveParents } from "@twenty/scanner";
import type { Ctx } from "../ctx.js";
import { season as seasonOf } from "../ctx.js";
import { makeCtx } from "../runtime.js";
import { runLifecycle, slotReminders } from "./lifecycle.js";
import { runSnapshots } from "./snapshots.js";
import { runScoreCron } from "./score-cron.js";
import { seasonClose, electionSnapshot, seasonJobsDue } from "./season.js";
import { runBans } from "./ban.js";
import { runHealth } from "./health.js";
import { pollPayments } from "../billing.js";

export interface Job { name: string; every?: number; at?: (ctx: Ctx, nowMs: number) => boolean; run: (ctx: Ctx) => Promise<unknown> }
const MIN = 60_000;
const utc = (nowMs: number) => { const d = new Date(nowMs); return { h: d.getUTCHours(), m: d.getUTCMinutes() }; };

export const JOBS: Job[] = [
  { name: "reminders", every: MIN, run: async (ctx) => ({ reminded: await slotReminders(ctx) }) },
  { name: "lifecycle", every: 10 * MIN, run: runLifecycle },
  { name: "snapshots-fresh", every: 30 * MIN, run: (ctx) => runSnapshots(ctx, { fresh: true }) },
  { name: "snapshots", every: 6 * 60 * MIN, run: (ctx) => runSnapshots(ctx) },
  { name: "scores", at: (_c, now) => { const t = utc(now); return t.h === 0 && t.m >= 5 && t.m < 20; }, run: (ctx) => runScoreCron(ctx) },
  { name: "season", at: (ctx, now) => { const t = utc(now); return Boolean(seasonJobsDue(ctx).closePrevious) && t.h === 0 && t.m >= 15 && t.m < 59; }, run: (ctx) => seasonClose(ctx, seasonJobsDue(ctx).closePrevious!) },
  { name: "election-snapshot", at: (ctx, now) => { const t = utc(now); return seasonJobsDue(ctx).snapshot && t.h === 0 && t.m >= 2 && t.m < 59; }, run: (ctx) => electionSnapshot(ctx) },
  { name: "health", every: MIN, run: runHealth },
  { name: "bans", every: 5 * MIN, run: async (ctx) => ({ executed: await runBans(ctx) }) },
  { name: "indexer", every: 15 * MIN, run: (ctx) => resolveParents(ctx.helius, ctx.pool, 25) },
  { name: "billing", every: 30_000, run: async (ctx) => { if (!ctx.treasury) return { skipped: "no treasury" }; const issued = await pollPayments(ctx.helius, ctx.pool, ctx.treasury, ctx); return { issued }; } },
];

const lockKey = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

const RETRY_AFTER_FAILURE = 5 * MIN;

/**
 * Runs one job now if it is due: by cadence, or inside its clock window when it has not succeeded there yet.
 * A failed run is retried after five minutes (inside the window for clock jobs), so one bad RPC minute never
 * costs a whole day; a run that never finished (process died) counts as failed.
 */
export async function runJobIfDue(ctx: Ctx, job: Job, nowMs = ctx.now()): Promise<boolean> {
  const { rows: [last] } = await ctx.pool.query(`select started_at, finished_at, ok from job_runs where name=$1 order by started_at desc limit 1`, [job.name]);
  const lastMs = last ? new Date(last.started_at).getTime() : 0;
  const lastFailed = Boolean(last) && (last.ok === false || (last.finished_at == null && nowMs - lastMs > 30 * MIN));
  const running = Boolean(last) && last.finished_at == null && !lastFailed;
  if (running) return false;
  if (job.every && nowMs - lastMs < (lastFailed ? Math.min(job.every, RETRY_AFTER_FAILURE) : job.every)) return false;
  if (job.at) { if (!job.at(ctx, nowMs)) return false; if (nowMs - lastMs < (lastFailed ? RETRY_AFTER_FAILURE : 60 * MIN)) return false; }
  const { rows: [lk] } = await ctx.pool.query(`select pg_try_advisory_lock($1) as ok`, [lockKey(job.name)]);
  if (!lk?.ok) return false;
  const { rows: [run] } = await ctx.pool.query(`insert into job_runs(name) values ($1) returning id`, [job.name]);
  try {
    const detail = await job.run(ctx);
    await ctx.pool.query(`update job_runs set finished_at=now(), ok=true, detail=$2 where id=$1`, [run.id, JSON.stringify(detail ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 8000)]);
    ctx.log.info({ job: job.name, detail }, "job ok");
  } catch (e) {
    await ctx.pool.query(`update job_runs set finished_at=now(), ok=false, detail=$2 where id=$1`, [run.id, JSON.stringify({ error: (e as Error).message })]);
    ctx.log.error({ job: job.name, err: (e as Error).message }, "job failed");
  } finally { await ctx.pool.query(`select pg_advisory_unlock($1)`, [lockKey(job.name)]).catch(() => {}); }
  return true;
}

/** One pass over every job. Jobs are independent (each holds its own advisory lock), so they run concurrently: a slow snapshot pass never delays billing. */
export async function tick(ctx: Ctx, jobs = JOBS) {
  const results = await Promise.allSettled(jobs.map((j) => runJobIfDue(ctx, j)));
  results.forEach((r, i) => { if (r.status === "rejected") ctx.log.error({ job: jobs[i].name, err: String(r.reason) }, "job scheduling failed"); });
  return results.map((r, i) => ({ name: jobs[i].name, ran: r.status === "fulfilled" && r.value }));
}

/** On start-up: runs the previous process left unfinished are marked failed so their jobs retry promptly, and old rows are trimmed. */
export async function recoverRuns(ctx: Ctx) {
  await ctx.pool.query(`update job_runs set finished_at = now(), ok = false, detail = '{"error":"interrupted"}' where finished_at is null`);
  await ctx.pool.query(`delete from job_runs where started_at < now() - interval '30 days'`);
}

if (process.argv[1] && /runner\.(ts|js)$/.test(process.argv[1])) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL missing"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, statement_timeout: 60_000 });
  const ctx = makeCtx({ pool, log: { info: (o, m) => console.log(JSON.stringify({ level: "info", msg: m, ...(typeof o === "object" ? o : { o }) })), warn: (o, m) => console.warn(JSON.stringify({ level: "warn", msg: m, ...(typeof o === "object" ? o : { o }) })), error: (o, m) => console.error(JSON.stringify({ level: "error", msg: m, ...(typeof o === "object" ? o : { o }) })) } });
  let stopping = false;
  const loop = async () => { if (stopping) return; try { await tick(ctx); } catch (e) { console.error(e); } if (!stopping) setTimeout(loop, 30_000); };
  await recoverRuns(ctx).catch((e) => console.error(e));
  const stop = () => { stopping = true; pool.end().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(JSON.stringify({ level: "info", msg: "runner up", season: seasonOf(ctx).season, day: seasonOf(ctx).day, oracle: ctx.oracle.enabled }));
  loop();
}
