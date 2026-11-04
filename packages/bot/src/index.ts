/**
 * @twenty/bot — delivers pad events to the Telegram channel, to self-service Telegram subscribers (tg_subs) and to Web Push.
 * Polls `events` where delivered_at is null, formats, sends, marks delivered. Commands: see commands.ts / docs/BOT.md.
 * The message texts are the same ones the public site previews in its alert builder.
 */
import { Bot } from "grammy";
import { Pool } from "pg";
import * as C from "./commands.js";
import { pushMatches, pushMessageFor, sendPush, configureVapid, type Db, type PushSender } from "@twenty/shared";

type Ev = { id: number; at: string; type: string; seat: number | null; mint: string | null; payload: Record<string, unknown> };

export * from "./commands.js";
const SITE = process.env.PUBLIC_SITE_URL ?? "https://cadre-us.org";
const pad2 = (n: number) => String(n).padStart(2, "0");
const seatLink = (seat: number | null) => (seat ? `${SITE}#seat-${pad2(seat)}` : SITE);
/** the launch room is where a slot reminder or a "live" push should land */
export const eventLink = (type: string, seat: number | null) => (seat && (type === "slot_soon" || type === "launch_live") ? `${SITE}#room-${pad2(seat)}` : seatLink(seat));

export function formatEvent(e: Ev, developer = ""): string {
  const p = e.payload as Record<string, string | number>; const who = e.seat ? `Seat ${pad2(e.seat)} ${developer}`.trim() : "The pad";
  switch (e.type) {
    case "slot_booked": return `${who} booked ${p.slot_time} UTC. Ticker at launch. Score ${p.score}.`;
    case "slot_soon": return `${who} launches in ${p.minutes} min (${String(p.slot_time).slice(11, 16)} UTC). The CA drops here at launch, never before.`;
    case "launch_live": return `LIVE · ${who} launched $${p.ticker} at $${Number(p.launch_cap_usd).toLocaleString()}. Dev ${p.dev_pct}% vested 30 d · LP ${p.liquidity} · no bond: a malicious launch means a permanent ban.`;
    case "report_due": return `${who}: day-${p.which} report for $${p.ticker} is due in 24 h. Late by more than 24 h = warning.`;
    case "zone_change": return `${who} ${p.to === "notice" ? "entered" : "left"} the replacement zone at ${p.score}. Window opens ${String(p.window_opens).slice(0, 10)}.`;
    case "challenge": return `Challenge ${p.kind === "filed" ? "filed" : "signaled"} against ${who} by ${p.challenger}${p.kind === "filed" ? " · evidence is public · committee decides within 24 h · holder signal open" : ""}.`;
    case "ban": return `BAN · ${who}: ${p.reason}. Permanently banned from the platform, ${p.wallets} wallet${Number(p.wallets) === 1 ? "" : "s"} blocked. Seat vacated and refilled from the bench.`;
    case "decision": return `${p.vote === "rulebook" ? "Rulebook" : "Committee"} · ${p.type}: ${p.subject} — ${p.outcome}${p.vote && p.vote !== "rulebook" ? ` (${p.vote})` : ""}.`;
    case "decision_proposed": return `Committee proposal · ${p.type}: ${p.subject} — ${p.outcome}. Needs ${p.needs} of 5.`;
    case "slot_pending": return `${who} reserved ${String(p.slot_time).slice(0, 16).replace("T", " ")} UTC — fee pending.`;
    case "slot_cancelled": return `${who} released ${String(p.slot_time).slice(0, 16).replace("T", " ")} UTC with ${p.notice_hours} h notice.`;
    case "slot_missed": return `${who} missed ${String(p.slot_time).slice(0, 16).replace("T", " ")} UTC (${p.why}). ${p.fine_sol} SOL fine, warning on record.`;
    case "booking_expired": return `${who}: unpaid booking for ${String(p.slot_time).slice(0, 16).replace("T", " ")} UTC expired; the slot is open again.`;
    case "launch_open": return `${who}: $${p.ticker} passed day ${p.day} — the seat may book again.`;
    case "launch_settled": return `${who}: $${p.ticker} settled at day 30 · holder outcome ${p.holder_outcome_pct}% of ${Number(p.holders_counted).toLocaleString()} holders.`;
    case "launch_flagged": return `${who}: $${p.ticker} registered with ${p.flags} flagged pre-check${Number(p.flags) > 1 ? "s" : ""} — committee review.`;
    case "launch_rejected": return `${who}: a mint created ${String(p.created_at).slice(0, 16).replace("T", " ")} UTC was refused — ${p.why}.`;
    case "launch_disclosed": return `${who}: disclosure for $${p.ticker} published.`;
    case "report_filed": return `${who}: day-${p.which} report for $${p.ticker} filed${p.state === "late" ? " (late — warning)" : ""}.`;
    case "application": return `New application ${p.ref} · ${p.launches} prior launches · pre-check ${p.precheck_score}.`;
    case "public_review": return `Public review open on ${p.handle} for ${p.hours} h · a flag with on-chain evidence the committee upholds pays ${p.bounty_sol} SOL.`;
    case "flag_filed": return `Flag filed on ${p.handle} (${p.evidence} piece${Number(p.evidence) > 1 ? "s" : ""} of evidence).`;
    case "bench_joined": return `${p.handle} joined the bench at #${p.rank} (pre-check ${p.score}).`;
    case "bounty": return `Bounty paid · ${p.sol} SOL for an upheld flag.`;
    case "seat_assigned": return `${who} assigned from the bench.`;
    case "seat_replaced": return `${who} replaced by challenge.`;
    case "seat_vacated": return `${who} vacated — on notice at two consecutive closes.`;
    case "seat_suspended": return `${who} suspended for ${p.days} days · ${p.reason}.`;
    case "seat_restored": return `${who} restored · suspension over.`;
    case "tenured": return `${who} is tenured after ${p.seasons} clean seasons · one extra slot per season.`;
    case "season_close": return `Season ${p.season} closed · ${(p.notice as unknown as number[]).length} on notice${(p.vacated as unknown as number[]).length ? `, ${(p.vacated as unknown as number[]).length} vacated` : ""} · ${Number(p.pool_sol).toFixed(2)} SOL seat pool distributed.`;
    case "candidacy": return `${p.handle} stands for the People's Seat (season ${p.season}).`;
    case "election_snapshot": return `People's Seat · day-20 snapshot taken · ${Number(p.wallets).toLocaleString()} eligible wallets.`;
    case "ballot": return `People's Seat · ballot ${p.moved ? "moved to" : "cast for"} ${p.candidate} · ${p.weight_pct}%.`;
    case "election_result": return `People's Seat · ${p.winner} elected with ${p.weight_pct}% (${p.wallets} wallets).`;
    default: return `${who}: ${e.type}`;
  }
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string; seats: number[]; events: string[] };
/** Web push for one event: every subscription whose scope matches gets it; gone subscriptions are deleted, failures counted (20 in a row disables). */
export async function pushEvent(pool: Db, e: Ev, text: string, link: string, send: PushSender = sendPush): Promise<number> {
  const { rows: subs } = await pool.query<Sub>(`select id, endpoint, p256dh, auth, seats, events from push_subscriptions where disabled_at is null`);
  let sent = 0;
  for (const s of subs.filter((x) => pushMatches({ seats: x.seats ?? [], events: x.events ?? [] }, e))) {
    const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, pushMessageFor(e, text, link));
    if (r.gone) await pool.query(`delete from push_subscriptions where id=$1`, [s.id]);
    else if (r.ok) { sent++; await pool.query(`update push_subscriptions set last_ok_at = now(), failures = 0 where id=$1`, [s.id]); }
    else await pool.query(`update push_subscriptions set failures = failures + 1, disabled_at = case when failures + 1 >= 20 then now() else disabled_at end where id=$1`, [s.id]);
  }
  return sent;
}

export async function dispatchOnce(pool: Db, bot: Bot | null, fetchImpl: typeof fetch = fetch, send: PushSender = sendPush) {
  const { rows: events } = await pool.query<Ev>(`select id, at, type, seat, mint, payload from events where delivered_at is null order by id limit 50`);
  if (!events.length) return 0;
  const { rows: devs } = await pool.query<{ seat: number; handle: string }>(`select s.seat, d.handle from seats s join developers d on d.id = s.developer_id`);
  const name = new Map(devs.map((d) => [d.seat, d.handle]));
  for (const e of events) {
    const text = formatEvent(e, e.seat ? name.get(e.seat) : "");
    const link = eventLink(e.type, e.seat);
    if (bot && process.env.TELEGRAM_ALERTS_CHANNEL && ["slot_booked", "launch_live", "ban", "zone_change", "decision", "season_close", "election_result", "seat_vacated", "seat_assigned", "bench_joined", "public_review"].includes(e.type)) {
      await bot.api.sendMessage(process.env.TELEGRAM_ALERTS_CHANNEL, `🔔 Cadre\n${text}\n→ ${link}`, { link_preview_options: { is_disabled: true } }).catch((err) => console.error("channel", err));
    }
    if (bot) {
      const html = `🔔 <b>Cadre</b>\n${C.esc(text)}\n<a href="${C.esc(link)}">Open</a>`;
      for (const chat of await C.subscribersFor(pool, e).catch(() => [] as string[])) {
        try { await bot.api.sendMessage(chat, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); await C.noteSend(pool, chat, true, false); }
        catch (err) { const code = (err as { error_code?: number }).error_code; await C.noteSend(pool, chat, false, code === 403 || code === 400).catch(() => {}); }
        await new Promise((r) => setTimeout(r, 40)); // stay far below Telegram's 30 msg/s limit
      }
    }
    try { await pushEvent(pool, e, text, link, send); } catch (err) { console.error("push", err instanceof Error ? err.message : err); }
    await pool.query(`update events set delivered_at = now() where id = $1`, [e.id]);
  }
  return events.length;
}

/** daily digest to the channel and to every chat that turned it on */
export async function runDigest(pool: Db, bot: Bot | null, now = Date.now()): Promise<boolean> {
  if (!bot || !(await C.digestDue(pool, now))) return false;
  const html = await C.digestText(pool, now); const opts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
  const targets = [...(process.env.TELEGRAM_ALERTS_CHANNEL ? [process.env.TELEGRAM_ALERTS_CHANNEL] : []), ...(await C.digestChats(pool))];
  for (const t of targets) { await bot.api.sendMessage(t, html, opts).catch((e) => console.error("digest", t, e instanceof Error ? e.message : e)); await new Promise((r) => setTimeout(r, 40)); }
  return true;
}

export function registerCommands(bot: Bot, pool: Db) {
  const last = new Map<string, number>(); // 1 command per second per chat
  bot.use(async (ctx, next) => { const id = String(ctx.chat?.id ?? ""); const t = Date.now(); if (id && ctx.message && (last.get(id) ?? 0) > t - 1000) return; if (id) last.set(id, t); if (last.size > 5000) last.clear(); await next(); });
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
  const arg = (ctx: { match?: unknown }) => Number(String(ctx.match ?? "").trim().replace(/^#?0*/, "") || NaN);
  const chat = (ctx: { chat?: { id: number } }) => String(ctx.chat?.id);
  bot.command("start", (ctx) => ctx.reply(C.HELP + `\n\nYour chat id: <code>${ctx.chat.id}</code>`, { ...html, reply_markup: { inline_keyboard: [[{ text: "🏆 Leaderboard", callback_data: "m:lb" }, { text: "⏱ Next launches", callback_data: "m:next" }], [{ text: "🔔 Alerts", callback_data: "m:alerts" }, { text: "🟢 Status", callback_data: "m:status" }]] } }));
  bot.command("help", (ctx) => ctx.reply(C.HELP, html));
  bot.command("leaderboard", async (ctx) => ctx.reply(await C.leaderboard(pool), html));
  bot.command("top", async (ctx) => ctx.reply(await C.leaderboard(pool), html));
  bot.command("seat", async (ctx) => ctx.reply(await C.seatCard(pool, arg(ctx)), html));
  bot.command("next", async (ctx) => ctx.reply(await C.nextLaunches(pool), html));
  bot.command("live", async (ctx) => ctx.reply(await C.liveLaunches(pool), html));
  bot.command("bans", async (ctx) => ctx.reply(await C.latestBans(pool), html));
  bot.command("status", async (ctx) => ctx.reply(await C.systemStatus(pool), html));
  bot.command("watch", async (ctx) => ctx.reply(await C.watch(pool, chat(ctx), arg(ctx)), html));
  bot.command("unwatch", async (ctx) => ctx.reply(await C.unwatch(pool, chat(ctx), arg(ctx)), html));
  bot.command("watching", async (ctx) => ctx.reply(await C.watching(pool, chat(ctx)), html));
  bot.command("alerts", async (ctx) => { const s = await C.getSub(pool, chat(ctx)) ?? await C.toggleEvent(pool, chat(ctx), "__none__"); await ctx.reply("Tap to switch alert types on or off:", { reply_markup: C.alertsKeyboard(s) }); });
  bot.command("digest", async (ctx) => { const a = String(ctx.match ?? "").trim().toLowerCase(); const on = await C.setDigest(pool, chat(ctx), a === "on" ? true : a === "off" ? false : undefined); await ctx.reply(on ? "Daily digest on · 08:00 UTC." : "Daily digest off."); });
  bot.command("mute", async (ctx) => { await C.setMuted(pool, chat(ctx), true); await ctx.reply("Muted. /unmute to resume."); });
  bot.command("unmute", async (ctx) => { await C.setMuted(pool, chat(ctx), false); await ctx.reply("Alerts on again."); });
  bot.command("stop", async (ctx) => { await C.stopAll(pool, chat(ctx)); await ctx.reply("All your alerts are removed. /start to come back."); });
  bot.on("callback_query:data", async (ctx) => {
    const d = ctx.callbackQuery.data; const id = String(ctx.chat?.id ?? ctx.from.id);
    if (d.startsWith("ev:")) { const s = await C.toggleEvent(pool, id, d.slice(3)); await ctx.editMessageReplyMarkup({ reply_markup: C.alertsKeyboard(s) }).catch(() => {}); }
    else if (d === "digest") { await C.setDigest(pool, id); const s = (await C.getSub(pool, id))!; await ctx.editMessageReplyMarkup({ reply_markup: C.alertsKeyboard(s) }).catch(() => {}); }
    else if (d === "m:lb") await ctx.reply(await C.leaderboard(pool), html);
    else if (d === "m:next") await ctx.reply(await C.nextLaunches(pool), html);
    else if (d === "m:status") await ctx.reply(await C.systemStatus(pool), html);
    else if (d === "m:alerts") { const s = await C.getSub(pool, id) ?? await C.toggleEvent(pool, id, "__none__"); await ctx.reply("Tap to switch alert types on or off:", { reply_markup: C.alertsKeyboard(s) }); }
    await ctx.answerCallbackQuery().catch(() => {});
  });
  bot.api.setMyCommands([["leaderboard", "Top 10 today"], ["seat", "One seat, e.g. /seat 7"], ["next", "Upcoming launches"], ["live", "Launches in their 30-day window"], ["bans", "Latest bans"], ["status", "System status"], ["watch", "Alert me about a seat"], ["watching", "My alerts"], ["alerts", "Choose alert types"], ["digest", "Daily digest on/off"], ["mute", "Pause alerts"], ["help", "All commands"]].map(([command, description]) => ({ command, description }))).catch((e) => console.error("setMyCommands", e));
  bot.catch((err) => console.error("bot", err.message));
}

if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL missing"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, statement_timeout: 8_000 });
  const bot = process.env.TELEGRAM_BOT_TOKEN ? new Bot(process.env.TELEGRAM_BOT_TOKEN) : null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) configureVapid(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY, process.env.VAPID_SUBJECT || undefined);
  else console.warn("VAPID keys not set — web push disabled (npx web-push generate-vapid-keys)");
  const stop = () => { bot?.stop(); pool.end().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 8000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  if (bot) {
    registerCommands(bot, pool);
    bot.start().catch((e) => console.error(e));
  }
  const loop = async () => { try { await dispatchOnce(pool, bot); await runDigest(pool, bot); } catch (e) { console.error(e); } setTimeout(loop, 5000); };
  loop();
}
