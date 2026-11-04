/**
 * Web Push (VAPID) for the pad: one subscription per browser, scoped to seats and event types.
 *  - endpoints must be https and belong to a known push service (or any public host when PUSH_ALLOW_ANY_ENDPOINT=1),
 *    and pass the same SSRF guard as webhooks
 *  - a 404/410 from the push service means the subscription is gone and is deleted; other failures are counted
 *  - the payload is small (title, body, url, tag) so it fits every push service's limit
 */
import webpush from "web-push";
import { assertSafeWebhook } from "./net.js";

export interface PushSubscriptionJson { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
export interface PushMessage { title: string; body: string; url?: string; tag?: string; icon?: string; badge?: string }
export interface PushSender { (sub: PushSubscriptionJson, msg: PushMessage): Promise<{ ok: boolean; gone: boolean; status?: number }> }

/** Event types a browser may subscribe to, and what a fresh subscription gets when it names none. */
export const PUSH_EVENTS = ["slot_soon", "slot_booked", "launch_live", "report_due", "zone_change", "seat_suspended", "ban", "challenge", "decision", "season_close", "election_result", "bench_joined", "seat_assigned"] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];
export const PUSH_DEFAULT_EVENTS: PushEvent[] = ["slot_soon", "launch_live", "report_due", "zone_change", "ban", "challenge"];
/** Events that concern the whole pad reach every subscription whose event list names them, whatever its seats. */
export const PAD_WIDE_EVENTS = new Set<string>(["season_close", "election_result", "bench_joined", "decision"]);

const KNOWN_PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/i, /(^|\.)push\.services\.mozilla\.com$/i, /(^|\.)push\.apple\.com$/i, /(^|\.)notify\.windows\.com$/i, /(^|\.)wns\.windows\.com$/i, /(^|\.)push\.opera\.com$/i, /(^|\.)pushapi\.push\.samsung\.com$/i];
export function isKnownPushEndpoint(endpoint: string): boolean {
  try { const h = new URL(endpoint).hostname; return KNOWN_PUSH_HOSTS.some((re) => re.test(h)); } catch { return false; }
}
/** Validates an endpoint the way a webhook is validated, plus the push-service allowlist unless opened by env. */
export async function assertSafePushEndpoint(endpoint: string, allowAny = process.env.PUSH_ALLOW_ANY_ENDPOINT === "1"): Promise<void> {
  if (typeof endpoint !== "string" || endpoint.length > 1024) throw new Error("endpoint too long");
  const known = isKnownPushEndpoint(endpoint);
  if (!allowAny && !known) throw new Error("endpoint is not a known push service");
  // a known push service is public by definition, so its name is not resolved here (and the check works offline); anything else gets the full guard
  await assertSafeWebhook(endpoint, known ? async () => [{ address: "8.8.8.8" }] : undefined);
}

/** Does an event reach a subscription? Empty seats = every seat; empty events = the defaults. */
export function pushMatches(sub: { seats: number[]; events: string[] }, ev: { type: string; seat: number | null }): boolean {
  const events = sub.events.length ? sub.events : PUSH_DEFAULT_EVENTS;
  if (!events.includes(ev.type)) return false;
  if (PAD_WIDE_EVENTS.has(ev.type) || ev.seat == null) return true;
  return sub.seats.length === 0 || sub.seats.includes(ev.seat);
}

/** Title + body for a push, from the same text the bot sends to Telegram. */
export function pushMessageFor(ev: { type: string; seat: number | null; payload: Record<string, unknown> }, text: string, link: string): PushMessage {
  const p = ev.payload as Record<string, string | number>; const seat = ev.seat ? `Seat ${String(ev.seat).padStart(2, "0")}` : "Cadre";
  const titles: Record<string, string> = {
    slot_soon: `${seat} launches in ${p.minutes ?? 15} min`, slot_booked: `${seat} booked a slot`, launch_live: `LIVE · $${p.ticker ?? ""} · ${seat}`, report_due: `${seat}: day-${p.which ?? ""} report due`,
    zone_change: `${seat} ${p.to === "notice" ? "entered" : "left"} the zone`, seat_suspended: `${seat} suspended`, ban: `BAN · ${seat}`, challenge: `Challenge · ${seat}`,
    decision: "Committee decision", season_close: "Season closed", election_result: "Seat 20 elected", bench_joined: "New developer on the bench", seat_assigned: `${seat} has a new developer`,
  };
  return { title: titles[ev.type] ?? `${seat} · ${ev.type.replace(/_/g, " ")}`, body: text.slice(0, 180), url: link, tag: `${ev.type}-${ev.seat ?? "pad"}` };
}

let configured = false;
export function configureVapid(publicKey: string, privateKey: string, subject = "mailto:security@cadre-us.org"): void {
  webpush.setVapidDetails(subject, publicKey, privateKey); configured = true;
}
export function generateVapidKeys(): { publicKey: string; privateKey: string } { return webpush.generateVAPIDKeys(); }
export const vapidConfigured = () => configured;

/** Sends one push. Never throws: the result says whether the subscription is gone (delete it) or merely failed (count it). */
export const sendPush: PushSender = async (sub, msg) => {
  if (!configured) return { ok: false, gone: false, status: 0 };
  try {
    const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(msg), { TTL: 3600, urgency: msg.tag?.startsWith("slot_soon") || msg.tag?.startsWith("launch_live") ? "high" : "normal", timeout: 8000 });
    return { ok: r.statusCode >= 200 && r.statusCode < 300, gone: false, status: r.statusCode };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    return { ok: false, gone: status === 404 || status === 410, status };
  }
};
