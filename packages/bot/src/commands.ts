/**
 * Telegram commands for the Cadre bot. Everything reads the same tables the public API serves; nothing here writes
 * except the caller's own subscription row (tg_subs). Output is Telegram HTML, every dynamic value is escaped.
 */
import type { Db } from "@twenty/shared";

const SITE = process.env.PUBLIC_SITE_URL ?? "https://cadre-us.org";
const pad2 = (n: number) => String(n).padStart(2, "0");
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const utc = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const ago = (d: Date | string, now = Date.now()) => { const m = Math.max(0, Math.round((now - new Date(d).getTime()) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const inn = (d: Date | string, now = Date.now()) => { const m = Math.max(0, Math.round((new Date(d).getTime() - now) / 60000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const medal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${String(r).padStart(2, " ")}.`);

export const ALL_EVENTS = ["slot_soon", "launch_live", "ban", "zone_change", "decision", "season_close", "election_result", "slot_booked", "report_due", "seat_vacated", "seat_assigned"] as const;
export const EVENT_LABEL: Record<string, string> = { slot_soon: "Launch reminders (15 min)", launch_live: "Launch is live", ban: "Bans", zone_change: "Replacement zone", decision: "Committee decisions", season_close: "Season close", election_result: "Election results", slot_booked: "Slots booked", report_due: "Reports due", seat_vacated: "Seat vacated", seat_assigned: "Seat assigned" };

export const HELP = [
  "<b>Cadre bot</b> — 20 vetted developer seats, public ranking, no bond: a malicious launch means a permanent ban.",
  "",
  "<b>Look up</b>",
  "/leaderboard — top 10 today",
  "/seat 7 — one seat in detail",
  "/next — upcoming launches",
  "/live — launches in their 30-day window",
  "/bans — latest bans",
  "/status — system status",
  "",
  "<b>Alerts</b>",
  "/watch 7 — alert me about seat 7",
  "/unwatch 7 · /watching",
  "/alerts — choose event types",
  "/digest — daily leaderboard at 08:00 UTC",
  "/mute · /unmute · /stop",
  "",
  `<a href="${SITE}">Open Cadre</a> · <a href="${SITE}/status.html">Status page</a>`,
].join("\n");

export async function leaderboard(db: Db, limit = 10): Promise<string> {
  const { rows } = await db.query<{ seat: number; handle: string; score: number; rank: number; day: string; status: string }>(
    `select s.seat, d.handle, sc.score, sc.rank, sc.day::text, s.status from scores sc join seats s on s.seat = sc.seat left join developers d on d.id = s.developer_id
     where sc.day = (select max(day) from scores) order by sc.rank limit $1`, [limit]);
  if (!rows.length) return "No scores yet. The first oracle write happens at 00:00 UTC after the season starts.";
  const lines = rows.map((r) => `${medal(r.rank)} <b>${pad2(r.seat)}</b> ${esc(r.handle ?? "—")} · ${r.score}${r.status === "notice" ? " ⚠️" : ""}`);
  return `<b>Leaderboard · ${esc(rows[0].day)}</b>\n${lines.join("\n")}\n\n⚠️ = replacement zone · <a href="${SITE}#leaderboard">full table</a>`;
}

export async function seatCard(db: Db, n: number, now = Date.now()): Promise<string> {
  if (!Number.isInteger(n) || n < 1 || n > 20) return "Usage: /seat 1–20";
  const { rows } = await db.query<{ seat: number; handle: string | null; status: string; score: number | null; rank: number | null; survival_pct: string | null; holder_outcome_pct: string | null; median_peak_x: string | null; warnings: number | null; suspended_until: string | null }>(
    `select s.seat, d.handle, s.status, sc.score, sc.rank, sc.survival_pct, sc.holder_outcome_pct, sc.median_peak_x, sc.warnings, s.suspended_until
     from seats s left join developers d on d.id = s.developer_id
     left join scores sc on sc.seat = s.seat and sc.day = (select max(day) from scores) where s.seat = $1`, [n]);
  const r = rows[0]; if (!r) return `Seat ${pad2(n)} not found.`;
  if (r.status === "vacant" || !r.handle) return `<b>Seat ${pad2(n)}</b> — vacant. <a href="${SITE}#apply">Apply</a>`;
  const out = [`<b>Seat ${pad2(n)} · ${esc(r.handle)}</b> — ${esc(r.status)}${r.suspended_until ? ` until ${utc(r.suspended_until).slice(0, 10)}` : ""}`];
  if (r.score != null) out.push(`Score <b>${r.score}</b> · rank #${r.rank}`, `Survival ${r.survival_pct}% · holder outcome ${r.holder_outcome_pct}% · median peak ${r.median_peak_x}x · warnings ${r.warnings}`);
  const nxt = await db.query<{ slot_at: string }>(`select slot_at from bookings where seat = $1 and status = 'confirmed' and slot_at > $2 order by slot_at limit 1`, [n, new Date(now)]);
  if (nxt.rows[0]) out.push(`Next launch: ${utc(nxt.rows[0].slot_at)} (in ${inn(nxt.rows[0].slot_at, now)})`);
  const last = await db.query<{ ticker: string; launched_at: string; status: string }>(`select ticker, launched_at, status from launches where seat = $1 order by launched_at desc limit 1`, [n]);
  if (last.rows[0]) out.push(`Last launch: $${esc(last.rows[0].ticker)} ${ago(last.rows[0].launched_at, now)} ago (${esc(last.rows[0].status)})`);
  out.push(`<a href="${SITE}#seat-${pad2(n)}">Seat page</a>`);
  return out.join("\n");
}

export async function nextLaunches(db: Db, now = Date.now()): Promise<string> {
  const { rows } = await db.query<{ seat: number; handle: string; slot_at: string }>(
    `select b.seat, d.handle, b.slot_at from bookings b join developers d on d.id = b.developer_id where b.status = 'confirmed' and b.slot_at > $1 order by b.slot_at limit 6`, [new Date(now)]);
  if (!rows.length) return "No launches announced yet. Tickers are revealed at launch, never before.";
  return `<b>Upcoming launches</b>\n${rows.map((r) => `${utc(r.slot_at)} · in ${inn(r.slot_at, now)} · Seat ${pad2(r.seat)} ${esc(r.handle)}`).join("\n")}\n\nThe CA drops in the launch room at launch, never before.`;
}

export async function liveLaunches(db: Db, now = Date.now()): Promise<string> {
  const { rows } = await db.query<{ ticker: string; seat: number; handle: string; launched_at: string; status: string; launch_cap_usd: string | null }>(
    `select l.ticker, l.seat, d.handle, l.launched_at, l.status, l.launch_cap_usd from launches l join developers d on d.id = l.developer_id where l.status in ('live','open') order by l.launched_at desc limit 8`);
  if (!rows.length) return "No launch in its 30-day window right now.";
  return `<b>In the 30-day window</b>\n${rows.map((r) => `$${esc(r.ticker)} · Seat ${pad2(r.seat)} ${esc(r.handle)} · day ${Math.floor((now - new Date(r.launched_at).getTime()) / 86_400_000)}${r.launch_cap_usd ? ` · launch cap $${Number(r.launch_cap_usd).toLocaleString("en-US")}` : ""}`).join("\n")}`;
}

export async function latestBans(db: Db, now = Date.now()): Promise<string> {
  const { rows } = await db.query<{ seat: number; handle: string | null; reason: string; executed_at: string }>(
    `select b.seat, d.handle, b.reason, b.executed_at from bans b left join developers d on d.id = b.developer_id where b.executed_at is not null order by b.executed_at desc limit 5`);
  if (!rows.length) return "No bans so far. 🟢";
  return `<b>Latest bans</b>\n${rows.map((r) => `${ago(r.executed_at, now)} ago · Seat ${pad2(r.seat)} ${esc(r.handle ?? "")} — ${esc(r.reason).slice(0, 160)}`).join("\n")}\n\nPermanent, linked wallets included. Full record: ${SITE}#bans`;
}

export async function systemStatus(db: Db): Promise<string> {
  const { rows } = await db.query<{ component: string; state: string; detail: string | null }>(`select component, state, detail from health_state order by component`);
  if (!rows.length) return "No status yet.";
  const icon: Record<string, string> = { operational: "🟢", degraded: "🟡", down: "🔴", off: "⚪" };
  const worst = rows.some((r) => r.state === "down") ? "Outage" : rows.some((r) => r.state === "degraded") ? "Degraded" : "All systems operational";
  return `<b>${worst}</b>\n${rows.map((r) => `${icon[r.state] ?? "⚪"} ${esc(r.component)}${r.detail ? ` — ${esc(r.detail)}` : ""}`).join("\n")}\n\n<a href="${SITE}/status.html">Status page</a>`;
}

/* ─── subscriptions ───────────────────────────────────────────────────── */
export type TgSub = { chat_id: string; seats: number[]; events: string[]; muted: boolean; digest: boolean };
export async function getSub(db: Db, chat: string): Promise<TgSub | null> {
  const { rows } = await db.query<TgSub>(`select chat_id, seats::int[] as seats, events, muted, digest from tg_subs where chat_id = $1`, [chat]); return rows[0] ?? null;
}
async function ensure(db: Db, chat: string) { await db.query(`insert into tg_subs(chat_id) values ($1) on conflict do nothing`, [chat]); return (await getSub(db, chat))!; }

export async function watch(db: Db, chat: string, n: number): Promise<string> {
  if (!Number.isInteger(n) || n < 1 || n > 20) return "Usage: /watch 1–20";
  const s = await ensure(db, chat); if (s.seats.includes(n)) return `Already watching Seat ${pad2(n)}.`;
  const seats = [...s.seats, n].sort((a, b) => a - b);
  await db.query(`update tg_subs set seats = $2::smallint[], muted = false, failures = 0 where chat_id = $1`, [chat, seats]);
  return `✅ Watching Seat ${pad2(n)}. You get its launch reminder, live alert, reports and zone changes — plus bans and decisions pad-wide.`;
}
export async function unwatch(db: Db, chat: string, n: number): Promise<string> {
  const s = await getSub(db, chat); if (!s || !s.seats.includes(n)) return `You are not watching Seat ${pad2(n)}.`;
  await db.query(`update tg_subs set seats = $2::smallint[] where chat_id = $1`, [chat, s.seats.filter((x) => x !== n)]);
  return `Stopped watching Seat ${pad2(n)}.`;
}
export async function watching(db: Db, chat: string): Promise<string> {
  const s = await getSub(db, chat); if (!s) return "No alerts set up. Try /watch 7 or /alerts.";
  return `<b>Your alerts</b>${s.muted ? " (muted)" : ""}\nSeats: ${s.seats.length ? s.seats.map(pad2).join(", ") : "all"}\nEvents: ${s.events.map((e) => EVENT_LABEL[e] ?? e).join(", ") || "none"}\nDaily digest: ${s.digest ? "on" : "off"}`;
}
export async function toggleEvent(db: Db, chat: string, ev: string): Promise<TgSub> {
  if (!(ALL_EVENTS as readonly string[]).includes(ev)) return ensure(db, chat);
  const s = await ensure(db, chat); const events = s.events.includes(ev) ? s.events.filter((x) => x !== ev) : [...s.events, ev];
  await db.query(`update tg_subs set events = $2::text[], muted = false where chat_id = $1`, [chat, events]); return (await getSub(db, chat))!;
}
export async function setDigest(db: Db, chat: string, on?: boolean): Promise<boolean> {
  const s = await ensure(db, chat); const v = on ?? !s.digest; await db.query(`update tg_subs set digest = $2 where chat_id = $1`, [chat, v]); return v;
}
export async function setMuted(db: Db, chat: string, muted: boolean) { await ensure(db, chat); await db.query(`update tg_subs set muted = $2 where chat_id = $1`, [chat, muted]); }
export async function stopAll(db: Db, chat: string) { await db.query(`delete from tg_subs where chat_id = $1`, [chat]); }

/** inline keyboard for /alerts: one toggle per event type */
export function alertsKeyboard(s: TgSub) {
  const rows = ALL_EVENTS.map((e) => [{ text: `${s.events.includes(e) ? "✅" : "▫️"} ${EVENT_LABEL[e]}`, callback_data: `ev:${e}` }]);
  return { inline_keyboard: [...rows, [{ text: s.digest ? "✅ Daily digest" : "▫️ Daily digest", callback_data: "digest" }]] };
}

/* ─── delivery ────────────────────────────────────────────────────────── */
const GLOBAL = new Set(["ban", "decision", "season_close", "election_result"]);
/** Does this subscriber want this event? Seat-scoped events need the seat on the watch list (or an empty list = all seats). */
export function subWants(s: TgSub, e: { type: string; seat: number | null }): boolean {
  if (s.muted) return false;
  const family: Record<string, string> = { seat_suspended: "zone_change", slot_cancelled: "slot_booked", slot_missed: "slot_booked", report_filed: "report_due" };
  if (!s.events.includes(e.type) && !s.events.includes(family[e.type] ?? "")) return false;
  if (e.seat == null || GLOBAL.has(e.type) || !s.seats.length) return true;
  return s.seats.includes(e.seat);
}
export async function subscribersFor(db: Db, e: { type: string; seat: number | null }): Promise<string[]> {
  const { rows } = await db.query<TgSub>(`select chat_id, seats::int[] as seats, events, muted, digest from tg_subs where failures < 5`);
  return rows.filter((s) => subWants(s, e)).map((s) => s.chat_id);
}
export async function noteSend(db: Db, chat: string, ok: boolean, gone: boolean) {
  if (ok) await db.query(`update tg_subs set failures = 0 where chat_id = $1 and failures > 0`, [chat]);
  else if (gone) await db.query(`delete from tg_subs where chat_id = $1`, [chat]);           // blocked the bot / chat deleted
  else await db.query(`update tg_subs set failures = failures + 1 where chat_id = $1`, [chat]);
}

/** Daily digest: once per UTC day at/after 08:00, remembered in bot_state so a restart never sends it twice. */
export async function digestDue(db: Db, now = Date.now()): Promise<string | null> {
  const d = new Date(now); if (d.getUTCHours() < 8) return null;
  const day = d.toISOString().slice(0, 10);
  const { rows } = await db.query<{ value: string }>(`select value from bot_state where key = 'digest_day'`);
  if (rows[0]?.value === day) return null;
  const sc = await db.query(`select 1 from scores where day = (select max(day) from scores) limit 1`);
  if (!sc.rows.length) return null;
  await db.query(`insert into bot_state(key, value) values ('digest_day', $1) on conflict (key) do update set value = $1, updated_at = now()`, [day]);
  return day;
}
export async function digestText(db: Db, now = Date.now()): Promise<string> {
  return `☀️ <b>Cadre daily</b>\n\n${await leaderboard(db, 5)}\n\n${await nextLaunches(db, now)}`;
}
export async function digestChats(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ chat_id: string }>(`select chat_id from tg_subs where digest and not muted and failures < 5`); return rows.map((r) => r.chat_id);
}
