/**
 * @twenty/api — Fastify service behind api.cadre-us.org
 * Routes mirror the feeds the public site renders client-side (docs/API.md); the developer, committee and tool
 * routes live in src/routes/*. Hardening in docs/SECURITY.md. The scheduler is a separate process (jobs/runner.ts).
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
import type { Db } from "@twenty/shared";
import type { Helius } from "@twenty/scanner";
import type { Ctx } from "./ctx.js";
import { makeCtx } from "./runtime.js";
import { token } from "./security.js";
import { pollPayments } from "./billing.js";
import { publicRoutes } from "./routes/public.js";
import { devRoutes } from "./routes/dev.js";
import { committeeRoutes } from "./routes/committee.js";
import { toolRoutes } from "./routes/tools.js";
import { pushRoutes } from "./routes/push.js";
import { payRoutes } from "./routes/pay.js";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`${k} missing`); })();

export async function build(deps: { pool?: Db; helius?: Helius; ctx?: Partial<Ctx> } = {}) {
  const app = Fastify({
    logger: { level: env("LOG_LEVEL", "info"), redact: { paths: ["req.headers.authorization", "req.headers['x-signature']", "req.headers.cookie"], censor: "[redacted]" } },
    // TRUST_PROXY: "false" (default), "true" (behind a trusted load balancer only) or a comma list of proxy IPs/CIDRs
    trustProxy: env("TRUST_PROXY", "false") === "true" ? true : env("TRUST_PROXY", "false") === "false" ? false : env("TRUST_PROXY")!.split(",").map((x) => x.trim()),
    bodyLimit: 64 * 1024, requestTimeout: 10_000, connectionTimeout: 15_000, keepAliveTimeout: 65_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true, allErrors: false, unicodeRegExp: true } },
    disableRequestLogging: env("LOG_REQUESTS", "false") !== "true",
    genReqId: () => token(9),
  });
  const pool: Db = deps.pool ?? new Pool({ connectionString: env("DATABASE_URL"), max: Number(env("PG_POOL_MAX", "10")), statement_timeout: 8_000, query_timeout: 8_000 });
  const ctx = makeCtx({ pool, helius: deps.helius, log: { info: (o, m) => app.log.info(o as object, m), warn: (o, m) => app.log.warn(o as object, m), error: (o, m) => app.log.error(o as object, m) }, ...deps.ctx });

  /* headers: the API serves JSON only, so the CSP is "nothing"; CORP lets the site's fetch() read it */
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "cross-origin" }, hsts: { maxAge: 15552000, includeSubDomains: true } });
  const origins = env("CORS_ORIGINS", "*")!.split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: origins.includes("*") ? "*" : origins, methods: ["GET", "POST", "PATCH", "DELETE"], allowedHeaders: ["content-type", "x-wallet", "x-signature", "x-nonce", "x-issued"], credentials: false, maxAge: 600 });
  // RATE_LIMIT_PER_MINUTE=0 disables the limiter entirely (tests, trusted internal deployments) — route limits need the plugin too
  if (Number(env("RATE_LIMIT_PER_MINUTE", "60")) > 0) await app.register(rateLimit, { global: true, max: Number(env("RATE_LIMIT_PER_MINUTE", "60")), timeWindow: "1 minute", allowList: (req) => req.url === "/health" || req.url === "/ready", keyGenerator: (req) => req.ip });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", req.method === "GET" && req.url.startsWith("/v1/") && !/\/v1\/(keys|alerts|scan|wallets|push|pay)/.test(req.url) ? "public, max-age=15" : "no-store");
    return payload;
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 400 || err.validation) return reply.code(400).send({ error: "invalid request", detail: err.validation ? err.message : undefined });
    if (status === 413) return reply.code(413).send({ error: "payload too large" });
    if (status === 429) return reply.code(429).send({ error: "rate limited", retry_after: reply.getHeader("retry-after") });
    if (status < 500) return reply.code(status).send({ error: err.message });
    req.log.error({ err, reqId: req.id }, "unhandled");
    return reply.code(500).send({ error: "internal error", ref: req.id });
  });

  app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));
  app.get("/ready", async (_req, reply) => { try { await pool.query("select 1"); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); } });

  await publicRoutes(app, ctx);
  await devRoutes(app, ctx);
  await committeeRoutes(app, ctx);
  await toolRoutes(app, ctx);
  await pushRoutes(app, ctx);
  await payRoutes(app, ctx);

  /* single-instance deployments without the runner: the billing watcher can run in-process (BILLING_WATCHER=1) */
  let watcher: NodeJS.Timeout | null = null;
  if (process.env.BILLING_WATCHER === "1" && ctx.treasury) {
    const tick = async () => { try { await pollPayments(ctx.helius, pool, ctx.treasury!); } catch (e) { app.log.error(e); } watcher = setTimeout(tick, 30_000); };
    watcher = setTimeout(tick, 5_000);
  }
  app.addHook("onClose", async () => { if (watcher) clearTimeout(watcher); if (!deps.pool) await pool.end().catch(() => {}); });
  app.decorate("ctx", ctx);
  return app;
}

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  build().then((app) => {
    const stop = (sig: string) => { app.log.info({ sig }, "draining"); app.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 12_000).unref(); };
    process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
    return app.listen({ port: Number(process.env.PORT ?? 8080), host: env("HOST", "0.0.0.0") });
  }).catch((e) => { console.error(e); process.exit(1); });
}
