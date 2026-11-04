# Operations

How the pad runs day to day, what each process does, and what to do when something is off. The rules
themselves are in `docs/SPEC.md`; the security model in `docs/SECURITY.md`.

## The processes

| Process | Image entry | Needs | Does |
|---|---|---|---|
| `api` | `packages/api/dist/server.js` | Postgres, Helius key | the `/v1` feeds and every signed write route |
| `jobs` | `packages/api/dist/jobs/runner.js` | Postgres, Helius key, oracle keypair (optional) | the scheduler below; exactly one job instance runs at a time per job (advisory locks), so several replicas are safe |
| `bot` | `packages/bot/dist/index.js` | Postgres, Telegram token, VAPID keys | delivers `events` to the public channel, Telegram subscribers (`tg_subs`) and web-push subscriptions |
| `db` | postgres:16 | — | `packages/api/db/schema.sql` is idempotent (`npm run db:migrate`) |

The API never does scheduled work (set `BILLING_WATCHER=0`); the scheduler never serves HTTP. Both read the
same `.env` (`.env.example` lists every variable).

## The clock (what runs when, UTC)

| Job | Cadence | What it applies |
|---|---|---|
| `reminders` | every minute | "launches in 15 minutes" (`slot_soon`) once per confirmed slot — web push and Telegram pick it up |
| `lifecycle` | every 10 min | unpaid bookings expire after 2 h · a confirmed slot with no launch 60 min after it → missed (fee forfeited, 5 SOL fine, warning) · a creation by the seat wallet inside −5/+60 min of a booked slot → launch registered from chain data (disclosure due in 24 h) · launches `live` → `open` after 14 days → `settled` at day 30 with the holder outcome · report reminders 24 h before due, warnings 24 h after · public review over → bench · proposals older than 7 days expire · top-up deadline passed → suspended, bond restored → seated · nonces and old scans pruned |
| `snapshots-fresh` | every 30 min | price, market cap, holders and cost-basis positions for launches in their first 48 h |
| `snapshots` | every 6 h | the same for every live/open launch |
| `scores` | daily 00:05–00:20 | the §4 write: survival, holder outcome, median peak, warnings → score, rank, status (the public daily leaderboard); `zone_change` events; on chain when the oracle is configured |
| `season` | day 1, 00:15 | closes the previous season: bottom two / < 40 → notice, notice at two consecutive closes → vacated, tenure counters, seat-pool distribution by score (notice seats forfeit their share to the treasury), People's Seat result + ballot Merkle root |
| `election-snapshot` | day 20, 00:02 | every wallet's position across the season's launches (insiders excluded) → `election_snapshot` |
| `health` | every 1 min | probes API, database, scheduler, Solana RPC, market data, leaderboard, payments, alerts, program → `health_state`, `health_daily`; three bad probes open an incident, a good one resolves it. Served at `/v1/health`, shown on `web/status.html` |
| `bans` | every 5 min | executed Ban decisions → developer and linked wallets blocked (`banned_wallets`), launch marked banned, seat vacated, open bookings cancelled; no payout, no ledger entry |
| `indexer` | every 15 min | resolves funding parents for the deployer index (the collusion check) |
| `billing` | every 30 s | treasury transfers: `SLOT-…` SOL → booking confirmed + fee split (challenges are free, no memo) |

A failed run retries after five minutes; a run the process never finished (crash) is marked failed at the next
start and retried. `GET /v1/status` shows the last run of every job with its result — if any `ok` is false, or
`last_snapshot` or `last_score_day` is stale, something needs attention.

## Daily check (two minutes)

1. `GET /v1/status` — every job `ok`, `last_score_day` is today, `last_snapshot` within 6 h, `oracle` as expected.
2. `GET /v1/log?limit=50` — the last events read like a normal day (bookings, launches, reports, no run of warnings).
3. `GET /v1/pad` — `seat_pool_sol` and `treasury_sol` move only with slot fees, fines and season closes; there is no escrow.
4. The bot's public channel posted the day's launches.

## When something is off

| Symptom | Where to look | Fix |
|---|---|---|
| a job shows `ok: false` | `job_runs.detail` has the error message | Helius 429/5xx: wait, the retry is automatic; schema error: run `npm run db:migrate`; anything else: `docker logs jobs` |
| a booking stays `pending` after the developer paid | the memo on the transfer must match exactly; `billing` reads the treasury's last 50 transactions | ask for the signature; `SELECT * FROM bookings WHERE memo=…`; if the memo was wrong, the developer sends again with the right one — the first transfer is refunded by hand |
| a launch was not registered | `deployer_index` must contain the creation (Helius webhook or indexer); creator must be the seat wallet; creation inside −5/+60 min | the developer can `POST /v1/launches` with the mint; if the creation is outside the window the rules say missed slot |
| scores did not write at 00:05 | `scores` job detail; `launch_snapshots` missing for the window | the job retries every 5 min inside the window; `npm run -w @twenty/api cron:score` runs it by hand |
| the season did not close | `season` runs after the first score write on day 1; needs `scores` ok | run `scores` by hand, then wait for the next tick; or `node -e` → `seasonClose(ctx, season)` |
| `/ready` is 503 | Postgres unreachable | the API stays up and answers `/health`; fix the database connection |
| nobody gets push | `VAPID_*` set on `bot` **and** `api` (the key is served by the API, the bot sends); the site must be https (or localhost); `/v1/push/key` says `enabled` | generate keys once, set them on both services; a browser subscribed before the keys existed must turn notifications off and on again |
| the oracle fails | `SCORE_ORACLE_KEYPAIR`, `PROGRAM_ID`, `SOLANA_RPC_URL`; the keypair needs SOL for fees | every write is recorded with its inputs hash first; re-run `scores` once the oracle works and the on-chain write catches up |

## Deploying a change

1. `npm run build && npm test` — the 13 scenarios run on a real Postgres in-process, so a schema or rule change
   that breaks a flow fails here, not in production.
2. `node web/build.mjs` after any change to `web/index.html` (the CSP hashes every inline script).
3. `npm run db:migrate` (idempotent), then roll `api`, `jobs`, `bot`. The scheduler drains on `SIGTERM`; a job
   interrupted mid-run is recovered at the next start.

## Demo

`npm run demo` (or `DEMO_WALLET=<your address> DEMO_SPEED=60 npm run demo`) starts the whole machine on
`http://localhost:8080`: an in-process Postgres with the production schema, twenty seated developers with a
record, a committee, a bench, two upcoming bookings, a scripted chain and market, the scheduler ticking every
30 s. Point `web/config.js → API_BASE` at it and open `web/index.html`: the sample data is replaced by the
feeds, and with your wallet on seat 01 you can book a slot, "pay" it (`POST /demo/pay {memo}`), file reports,
challenge, vote — against the real rules. `DEMO_SPEED=60` runs a season day every 24 minutes so the
lifecycle (lock, reports, settlement, scores) can be watched in an afternoon.

## What the software cannot do

The committee is people: interviews, the public-review rulings, ban votes. The oracle keypair and the
treasury are keys someone holds. The program needs an audit and a devnet season before mainnet. Helius is a
paid dependency with rate limits sized in `.env`. None of that is a gap in the code; it is the part of the
pad that has to be run.
