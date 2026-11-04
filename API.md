# API — api.cadre-us.org/v1

Public routes need no key and are cached 15 s (`cache-control`), 60 s at the edge. Pro/Terminal routes take
Every param, query and body is schema-validated (`additionalProperties: false`); bodies are
capped at 64 KiB. Types: `packages/shared/src/types.ts`. The public site renders the same shapes
client-side, so a front-end switch to the live API is a one-line change (`web/config.js → API_BASE`).
Hardening details: `docs/SECURITY.md`.

| Route | Tier | Returns |
|---|---|---|
| `GET /v1/pad` | public | `PadFeed` — season, zone, seat pool, treasury, constants |
| `GET /v1/seats` | public | `SeatFeedRow[]` — 20 rows, daily score, 30-day history |
| `GET /v1/seats/:seat/inputs` | public | the exact inputs of today's score write + its sha256 |
| `GET /v1/slots` | public | `SlotFeedRow[]` — announced bookings (any time of day) |
| `GET /v1/launches` | public | `LaunchFeedRow[]` — last 100 launches, reports, disclosed wallets, ban |
| `GET /v1/launches/:mint/snapshots` | public | 6-hour mcap/holders series for the chart |
| `GET /v1/log?type=&seat=&limit=` | public | the pad log (events table); `limit` 1–500 |
| `GET /v1/decisions?status=&limit=` · `GET /v1/challenges?seat=` | public | committee record · challenges (signals, filed, decided) |
| `GET /v1/applications?stage=` · `GET /v1/applications/:ref` | public | vetting pipeline (public review, bench) · one application with its flags |
| `GET /v1/health` | public | status page feed: per-component state, 90-day uptime bars, incidents (probes run every minute) |
| `GET /v1/bans` | public | the ban list: seat, developer, reason, number of wallets blocked. A ban pays nothing out |
| `GET /v1/wallets/:wallet` | public (`no-store`) | everything the pad knows about a wallet: seat, application, committee role, open bookings, launches, election weight and ballot, lock |
| `GET /v1/status` | public | heartbeat of the machine: season day, every scheduled job's last run, last snapshot, last score write, deployer index size, oracle state |
| `GET /v1/scan/:address` | public (cached 6 h, 6/min per IP) | the four checks for a wallet or mint; free, no key |
| `GET /v1/verify/:mint` | public | badge verification for embeds |
| `POST /v1/waitlist` | public (5/min per IP) | `{contact}` handle or email → `{ok, position}` |
| `GET /v1/polls/:id` · `POST /v1/polls/:id/vote` | public | community calls; one vote per wallet or IP, tally public |
| `web/embed-next.html` | static | 360×190 widget: next launch from `/v1/slots` + `/v1/seats` |
| `GET /v1/election` | public | `Election` — season, phase, snapshot slot, candidates with weighted tally and wallet counts, turnout |
| `POST /v1/election/ballot` | public (wallet signature, 10/min) | `{wallet, candidate, signature, nonce, issued_at}` → ballot recorded or moved; the wallet signs `ballotMessage(season, candidate, nonce, issued_at)` (see below); eligibility and weight come from the day-20 snapshot (cap 0.5% of supply per wallet) |
| `GET /v1/election/eligibility/:wallet` | public | weight at the snapshot, current ballot, a fresh `nonce` and the message template to sign |
| **Developer routes — wallet-signed (see below)** | | |
| `POST /v1/slots/book` `{slot_at}` | seat holder | §1: ≥ 48 h ahead, one open booking per seat, 14-day lock, 3 + 1 (tenured) slots a season, 60 a season. Returns `{booking_id, memo, amount_sol, pay_to, expires_at}`; the booking is `pending` until the 3 SOL fee with that memo lands (2 h), then `confirmed` and the fee is split 50/30/20 |
| `POST /v1/slots/:id/cancel` | seat holder | §7: with ≥ 24 h notice the slot frees (fee stays); closer than that it is a missed slot (5 SOL fine, warning) |
| `POST /v1/launches` `{mint, ticker?, dev_allocation_pct, liquidity, wallets[]}` | seat holder | §6: registers the launch for the seat's booked slot; the chain decides (creator = seat wallet, creation inside −5/+60 min of the slot); day-7/day-30 reports are scheduled, the 14-day lock starts |
| `PATCH /v1/launches/:mint` `{dev_allocation_pct, liquidity, wallets[]}` | seat holder | completes the disclosure of a launch the pad registered from chain data (24 h, then a warning) |
| `POST /v1/launches/:mint/reports/:which` `{url}` | seat holder | §6/§7: files the day-7 or day-30 report; `state` is `filed` or `late` (> 24 h = warning on the record) |
| `POST /v1/apply` `{handle, mints[], contact}` | any wallet | §2: ≥ 3 prior launches; the four checks run over each one → `{ref, precheck}`; the committee moves it to interview and public review |
| `POST /v1/applications/:ref/flags` `{claim, evidence[]}` | any wallet | §11: a flag during public review; upheld flags pay the 2 SOL bounty, three discarded flags lock the wallet |
| `POST /v1/challenges` `{seat, kind}` | bench developer | §5: `signal` any time (free, public); `filed` in the replacement window needs `evidence` (public) and is free → `status: filed` at once |
| `POST /v1/challenges/:id/holder-vote` `{vote}` | holder | §5: keep/replace, weighted by the wallet's position across the incumbent's last three launches |
| `POST /v1/election/candidacy` `{statement?}` | bench developer | §12: during nominations; the committee confirms eligibility only |
| `GET /v1/developers/:wallet` | public | the developer behind a wallet: handle, seat or bench, record |
| **Committee routes — wallet-signed** | | |
| `POST /v1/committee/decisions` `{type, subject, outcome, payload?}` | committee member | proposes a Warning / Fine / Suspend / Ban / Challenge / Seat / Bench / Rejected / Recall / Bounty decision; public at once |
| `POST /v1/committee/decisions/:id/vote` `{vote}` | committee member | one vote each; 3 of 5 executes (bans go to the scheduler, which blocks the developer's and the linked wallets and vacates the seat the same day); proposals expire after 7 days |
| `POST /v1/webhooks/helius` | Helius | CREATE events feed the deployer index |
| `GET /v1/stream` (SSE) | Terminal | every event as it happens |
| `GET /v1/push/key` | public | `{enabled, public_key, events}` — the VAPID key a browser subscribes with |
| `POST /v1/push/subscribe` `{subscription, seats[], events[], wallet?}` · `DELETE` `{endpoint}` | public (10/min) | Web Push: one row per browser, scoped to seats (empty = all) and event types (empty = `slot_soon, launch_live, report_due, zone_change, ban, challenge`); endpoints must be https on a known push service (or any public host with `PUSH_ALLOW_ANY_ENDPOINT=1`) |
| `POST /v1/push/test` `{endpoint}` | public (3/min) | sends "notifications on" to that subscription; 404/410 from the push service deletes it |
| `GET /health` · `GET /ready` | ops | liveness · database ping |

### Errors
`400` invalid request (schema message in `detail`) · `401` bad ballot signature · `403` wallet not in the snapshot · `404` unknown rule / memo / candidate · `409` polls closed, nonce reused, rule limit · `413` body too large · `429` rate limited (`retry_after`) · `500` `{error, ref}` — quote `ref` when reporting · `503` not configured / database unreachable.

### Signed requests
Developer and committee routes carry no session. The wallet signs this exact text with `signMessage` (ed25519) and the request sends four headers: `x-wallet`, `x-signature` (base58 of the 64-byte signature), `x-nonce` (16–64 chars, accepted once) and `x-issued` (ISO-8601, within 10 minutes). `body` is the hex sha256 of the canonical JSON body (keys sorted, no whitespace; `{}` for an empty body). `web/dev.js` builds it for the site; `packages/shared/src/auth.ts` is the reference.
```
Cadre · <action>
wallet: <address>
nonce: <nonce>
issued: <ISO-8601>
body: <sha256 hex>

This signature authorises one request. It never spends funds.
```
Actions: `book slot`, `cancel slot`, `register launch`, `file report`, `apply`, `flag application`, `challenge`, `holder vote`, `committee vote`, `propose decision`, `declare candidacy`, `ballot`. Roles are looked up per request (seat holders, bench, committee), nothing is cached. Slot fees are never pulled from the wallet: the API returns a memo and the developer sends the SOL themselves; the scheduler matches the transfer within 30 s.

### Payments
`POST /v1/pay/prepare` `{memo, payer}` → the unsigned legacy transaction for the payer's wallet: a system transfer to the treasury plus a Memo instruction, with `amount_sol`, `lamports`, `pay_to`, `transaction` (base64), `blockhash`, and a Solana Pay link (`solana_pay`). Only `SLOT-XXXXXXXX` (pending, not expired) and `CHAL-XXXXXXXX` (pending bond) memos are accepted; amount and destination come from the database, never from the request. Nothing is signed or stored; 20/min per IP.
`GET /v1/pay/status/:memo` → `{state: pending|confirmed|expired, kind, seat, at}` — the page polls it while the card is open. The scheduler's billing poll (`pollPayments`) still decides what counts as paid.

### Local demo
`npm run demo` starts the whole machine on `http://localhost:8080` without Postgres or a Helius key: an in-process Postgres with the production schema, twenty seated developers with a record, a committee, a bench, upcoming bookings, a scripted chain and the scheduler. `POST /demo/pay {memo}` plays a fee payment on that chain. Set `DEMO_WALLET` to hold seat 01 with your own wallet and `web/config.js → API_BASE` to point the site at it.

### Signed ballots
The wallet signs this exact UTF-8 text (`packages/api/src/security.ts → ballotMessage`), base58-encodes the 64-byte ed25519 signature, and posts it with the nonce and timestamp it used. The timestamp must be within 10 minutes; a nonce is accepted once.
```
Cadre · Seat 20 ballot
season: <season>
candidate: <handle>
nonce: <nonce>
issued: <ISO-8601>

This signature casts or moves my ballot. It never spends funds.
```

### Web push
`web/push.js` registers `web/sw.js`, asks for permission, subscribes with the pad's VAPID key and posts the subscription with its scope. The bot delivers every matching event (`pushEvent` in `packages/bot`) as `{title, body, url, tag}`; `slot_soon` ("Seat 07 launches in 15 min") is emitted by the one-minute `reminders` job for confirmed slots. Twenty consecutive failures disable a subscription, 404/410 delete it. Keys: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

### Webhook signatures
Deliveries carry `x-twenty-timestamp` and `x-twenty-signature: v1=<hex>` where `hex = HMAC-SHA256(signing_secret, "<timestamp>.<raw body>")`. Verify with `verifyWebhookSignature()` from `@twenty/shared` (rejects a timestamp more than 5 minutes off). Deliveries time out after 5 s and never follow redirects; 20 consecutive failures disable the rule.
