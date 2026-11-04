/**
 * Web Push routes. A browser subscribes once (service worker + VAPID key), scoped to seats and event types; the
 * bot delivers matching events. No signature is needed: everything pushed is public pad activity, and a
 * subscription can only ever be removed by whoever holds its endpoint.
 */
import type { FastifyInstance } from "fastify";
import { PUSH_EVENTS, assertSafePushEndpoint, sendPush, vapidConfigured, PAD } from "@twenty/shared";
import type { Ctx } from "../ctx.js";

const SUB = { type: "object", additionalProperties: false, required: ["endpoint", "keys"], properties: {
  endpoint: { type: "string", minLength: 20, maxLength: 1024, pattern: "^https://" }, expirationTime: { type: ["number", "null"] },
  keys: { type: "object", additionalProperties: false, required: ["p256dh", "auth"], properties: { p256dh: { type: "string", minLength: 40, maxLength: 200, pattern: "^[A-Za-z0-9_=-]+$" }, auth: { type: "string", minLength: 10, maxLength: 100, pattern: "^[A-Za-z0-9_=-]+$" } } } } };
const BODY = { type: "object", additionalProperties: false, required: ["subscription"], properties: {
  subscription: SUB, seats: { type: "array", maxItems: PAD.SEATS, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: PAD.SEATS }, default: [] },
  events: { type: "array", maxItems: PUSH_EVENTS.length, uniqueItems: true, items: { type: "string", enum: [...PUSH_EVENTS] }, default: [] },
  wallet: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" } } };
const ENDPOINT = { type: "object", additionalProperties: false, required: ["endpoint"], properties: { endpoint: { type: "string", minLength: 20, maxLength: 1024, pattern: "^https://" } } };

export async function pushRoutes(app: FastifyInstance, ctx: Ctx) {
  const pool = ctx.pool; const publicKey = process.env.VAPID_PUBLIC_KEY || null;

  app.get("/v1/push/key", async () => ({ enabled: Boolean(publicKey && vapidConfigured()), public_key: publicKey, events: PUSH_EVENTS }));

  app.post<{ Body: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; seats: number[]; events: string[]; wallet?: string } }>("/v1/push/subscribe", { schema: { body: BODY }, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!publicKey) return reply.code(503).send({ error: "push is not configured on this pad" });
    const b = req.body; reply.header("cache-control", "no-store");
    try { await assertSafePushEndpoint(b.subscription.endpoint); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 160) : null;
    const { rows: [r] } = await pool.query(`insert into push_subscriptions(endpoint, p256dh, auth, seats, events, wallet, ua) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, seats = excluded.seats, events = excluded.events, wallet = excluded.wallet, ua = excluded.ua, failures = 0, disabled_at = null returning id, seats, events, created_at`,
      [b.subscription.endpoint, b.subscription.keys.p256dh, b.subscription.keys.auth, b.seats, b.events, b.wallet ?? null, ua]);
    return { ok: true, id: r.id, seats: r.seats, events: r.events.length ? r.events : "default", created_at: r.created_at };
  });

  app.delete<{ Body: { endpoint: string } }>("/v1/push/subscribe", { schema: { body: ENDPOINT }, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { rowCount } = await pool.query(`delete from push_subscriptions where endpoint=$1`, [req.body.endpoint]);
    reply.header("cache-control", "no-store"); return { ok: true, removed: Number(rowCount ?? 0) };
  });

  /** A test notification to a subscription that exists — the "does it work?" button. */
  app.post<{ Body: { endpoint: string } }>("/v1/push/test", { schema: { body: ENDPOINT }, config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { rows: [s] } = await pool.query(`select endpoint, p256dh, auth from push_subscriptions where endpoint=$1 and disabled_at is null`, [req.body.endpoint]);
    if (!s) return reply.code(404).send({ error: "not subscribed" });
    const r = await (ctx.sendPush ?? sendPush)({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, { title: "Cadre · notifications on", body: "This is how a slot reminder looks. You will hear from the pad only about the seats and events you chose.", url: "/#console", tag: "test" });
    if (r.gone) await pool.query(`delete from push_subscriptions where endpoint=$1`, [s.endpoint]);
    else await pool.query(r.ok ? `update push_subscriptions set last_ok_at = now(), failures = 0 where endpoint=$1` : `update push_subscriptions set failures = failures + 1 where endpoint=$1`, [s.endpoint]);
    return { ok: r.ok, status: r.status ?? null, gone: r.gone };
  });
}
