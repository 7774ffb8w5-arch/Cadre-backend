/**
 * Status probes (every minute). Each component gets a state — operational · degraded · down · off — written to
 * `health_state`, counted in `health_daily` (the 90-day bars) and, after three bad probes in a row, an incident is
 * opened; it is resolved on the first good probe. /v1/health serves all of it to the public status page.
 * The probes only read: nothing here changes pad state.
 */
import type { Ctx } from "../ctx.js";

export type HealthState = "operational" | "degraded" | "down" | "off";
export interface Probe { component: string; state: HealthState; latency_ms: number | null; detail: string }
export const COMPONENTS: Record<string, string> = {
  api: "API", database: "Database", scheduler: "Scheduler", chain: "Solana RPC", market: "Market data",
  leaderboard: "Daily leaderboard", payments: "Payments", alerts: "Alerts", program: "On-chain program",
};


export async function runProbes(ctx: Ctx): Promise<Probe[]> {
  const out: Probe[] = [];
  const ageMin = (d: unknown) => (d ? (ctx.now() - new Date(d as string).getTime()) / 60_000 : Infinity);
  const add = (component: string, state: HealthState, latency_ms: number | null, detail: string) => out.push({ component, state, latency_ms, detail });
  const t0 = Date.now();
  try { await ctx.pool.query("select 1"); const ms = Date.now() - t0; add("database", ms > 1500 ? "degraded" : "operational", ms, ms > 1500 ? "slow queries" : "responding"); add("api", "operational", ms, "serving requests"); }
  catch { add("database", "down", null, "no answer"); add("api", "degraded", null, "database unreachable"); return out; }
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T | undefined> => (await ctx.pool.query(sql)).rows[0] as T | undefined;
  const sched = await q<{ last: Date | null }>(`select max(started_at) as last from job_runs`);
  const a = ageMin(sched?.last); add("scheduler", a < 3 ? "operational" : a < 10 ? "degraded" : "down", null, a === Infinity ? "no run recorded" : `last run ${Math.round(a)} min ago`);
  const t1 = Date.now();
  try { await ctx.helius.rpcCall("getLatestBlockhash", [{ commitment: "confirmed" }]); const ms = Date.now() - t1; add("chain", ms > 2500 ? "degraded" : "operational", ms, ms > 2500 ? "slow responses" : "responding"); }
  catch { add("chain", "down", null, "RPC unreachable"); }
  const snap = await q<{ last: Date | null; n: number }>(`select max(at) as last, (select count(*)::int from launches where status in ('live','open')) as n from launch_snapshots`);
  if (!snap?.n) add("market", "operational", null, "no live launches to track");
  else { const m = ageMin(snap.last); add("market", m < 45 ? "operational" : m < 120 ? "degraded" : "down", null, `latest snapshot ${Math.round(m)} min ago`); }
  const sc = await q<{ last: Date | null }>(`select max(day) as last from scores`);
  const dAge = sc?.last ? (ctx.now() - new Date(sc.last as unknown as string).getTime()) / 3_600_000 : Infinity;
  add("leaderboard", dAge < 36 ? "operational" : dAge < 60 ? "degraded" : "down", null, sc?.last ? `scored ${new Date(sc.last as unknown as string).toISOString().slice(0, 10)}` : "no score yet");
  if (!ctx.treasury) add("payments", "off", null, "payments not configured");
  else { const b = await q<{ last: Date | null; ok: boolean | null }>(`select started_at as last, ok from job_runs where name='billing' order by started_at desc limit 1`); const m = ageMin(b?.last); add("payments", b?.ok !== false && m < 3 ? "operational" : m < 10 ? "degraded" : "down", null, b ? `last check ${Math.round(m)} min ago` : "no check yet"); }
  const ev = await q<{ oldest: Date | null }>(`select min(at) as oldest from events where delivered_at is null`);
  const e = ev?.oldest ? ageMin(ev.oldest) : 0; add("alerts", e < 10 ? "operational" : e < 60 ? "degraded" : "down", null, e < 10 ? "delivering" : `oldest queued alert ${Math.round(e)} min`);
  add("program", ctx.oracle.enabled ? "operational" : "off", null, ctx.oracle.enabled ? "oracle signing" : "not deployed yet");
  return out;
}

export async function runHealth(ctx: Ctx): Promise<{ probes: number; incidents: number }> {
  const probes = await runProbes(ctx); let incidents = 0;
  for (const p of probes) {
    const bad = p.state === "down" ? 1 : 0;
    const { rows: [prev] } = await ctx.pool.query(`select state, bad_streak from health_state where component=$1`, [p.component]);
    const streak = bad ? (prev?.bad_streak ?? 0) + 1 : 0;
    await ctx.pool.query(`insert into health_state(component, state, latency_ms, detail, bad_streak) values ($1,$2,$3,$4,$5)
      on conflict (component) do update set state=excluded.state, latency_ms=excluded.latency_ms, detail=excluded.detail, bad_streak=excluded.bad_streak, updated_at=now(), since = case when health_state.state = excluded.state then health_state.since else now() end`, [p.component, p.state, p.latency_ms, p.detail, streak]);
    if (p.state !== "off") await ctx.pool.query(`insert into health_daily(day, component, ok, degraded, total) values (current_date,$1,$2,$3,1)
      on conflict (day, component) do update set ok = health_daily.ok + excluded.ok, degraded = health_daily.degraded + excluded.degraded, total = health_daily.total + 1`, [p.component, p.state === "operational" ? 1 : 0, p.state === "degraded" ? 1 : 0]);
    if (streak === 3) { await ctx.pool.query(`insert into incidents(component, title) values ($1,$2)`, [p.component, `${COMPONENTS[p.component]}: ${p.detail}`]); incidents++; }
    if (!bad && prev?.bad_streak >= 3) await ctx.pool.query(`update incidents set resolved_at=now() where component=$1 and resolved_at is null`, [p.component]);
  }
  await ctx.pool.query(`delete from health_daily where day < current_date - 100`);
  return { probes: probes.length, incidents };
}
