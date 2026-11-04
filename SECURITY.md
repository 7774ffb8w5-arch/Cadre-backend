# Security

How Cadre is hardened, what each layer assumes, and how to report a problem. Everything here is
enforced in code and covered by `npm test`; the page suite (`scratch tsec.js`) runs the same checks against
the built site. Status: **not audited** — the program is a reference skeleton and is not deployed.

## Threat model in one paragraph

The site is a static page that renders JSON feeds and keeps a little per-viewer state in the browser. The API
is a public read-mostly service with two sensitive write routes (ballots, the indexer webhook). There are no accounts, subscriptions or API keys. The program holds no money at all (no bond, no escrow). The
things worth attacking are therefore: injecting markup into the page, abusing the API as a proxy (SSRF) or a
cost sink (RPC quota), forging or replaying ballots, and moving lamports out
of the program by substituting accounts or overflowing arithmetic.

## Site (`web/`)

- **Content-Security-Policy with script hashes.** `web/build.mjs` hashes every inline `<script>` and writes the
  policy into `index.html`, `web/_headers` and `infra/nginx-headers.conf`. `script-src` is `'self'` plus those
  hashes — an injected inline script, `javascript:` URL or inline event handler cannot run. `connect-src` names
  the API and the SOL price source only; `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`
  (header only). Style attributes stay allowed (`'unsafe-inline'` on `style-src`); they are not a script vector.
- **No inline event handlers** anywhere in the page; everything is delegated from scripts.
- **Boundary sanitising instead of per-template escaping.** The page interpolates hundreds of fields into
  templates. Rather than audit each one, every string that can come from outside is cleaned where it enters:
  `safeStr()` strips `< > " ' \` \` and control characters and caps the length; `live.js` runs every API field
  through it (`S()`), coerces numbers (`N()`), checks arrays (`A()`), validates wallet addresses and tickers
  against strict patterns and bounds array lengths. The API itself never returns user-written HTML.
- **Stored state is re-shaped on load.** `localStorage` can be edited by anything on the origin, so
  `sanitizeState()` rebuilds every collection into the exact record shape the renderers expect and drops the
  rest (roles must exist, seats are 1–20, wallets are base58, timestamps are numbers, strings are cleaned).
- **Hash routing** reads `location.hash` through `hashOf()` (decoded safely, capped at 80 characters); seat
  and launch ids are numeric and range-checked before a drawer opens.
- **Fetches** time out after 10 s, send no credentials, and only run against an `https://` API base.
- **Browser storage is only convenience.** Nothing in `localStorage` is trusted by the API.

## API (`packages/api`)

- **Validation before handlers.** Every param, query and body has a JSON schema (`additionalProperties:
  false`); bad input is a `400` that never touches the database (test: `validation`).
- **Limits.** 64 KiB body (1 MiB on the Helius webhook), 10 s request timeout, per-IP rate limit on every route,
  stricter limits on scanner (6/min per IP), votes and ballots (10/min).
- **Headers.** `@fastify/helmet` with `default-src 'none'` (the API serves JSON), HSTS, `nosniff`; CORS is a
  list of exact origins (or `*` for the public feeds), `GET/POST/DELETE`, no credentials.
  Public feeds are `public, max-age=15`; anything with ballots is `no-store`.
- **Errors.** One error handler: validation → 400 with the message, 413/429 passed through, everything else a
  generic 500 with a reference id; stack traces and SQL never leave the process. Logs redact
  `authorization` and cookies.


- **Indexer webhook.** Refuses to run without `HELIUS_WEBHOOK_SECRET`; compares the header in constant time;
  accepts arrays of at most 500 transactions.
- **Signed requests (developer and committee routes).** No sessions, no passwords, no API keys for
  developers: every write is an ed25519 signature by the wallet over a text that names the action, the wallet,
  a nonce, the time and the sha256 of the canonical JSON body (`packages/shared/src/auth.ts`). The server
  rebuilds the text from what it received, so a signature cannot be replayed (nonce table, 10-minute window),
  moved to another action, or attached to a different body. Roles (seat holder, bench, committee) are looked up
  per request from the tables. Slot fees are never pulled from a wallet: the developer sends the SOL with a
  memo the API issued, and the scheduler matches the transfer.
- **Ballots (§12).** A ballot is an ed25519 signature by the voting wallet over a canonical text that names
  the action, season, candidate, a nonce and an ISO timestamp (`ballotMessage()` in `security.ts`). The API
  checks the polls are open, the timestamp is within 10 minutes, the signature matches, the nonce is unused
  (unique table, inside the transaction), the wallet appears in the day-20 `election_snapshot`, and the
  candidate is confirmed. Weight is `min(snapshot, 0.5 %)`. Moving a ballot is the same signed message with
  another candidate; the previous choice is kept in `moved_from`. Nothing in a ballot can spend funds.
- **Payments.** `/v1/pay/prepare` only describes a transfer the database already says is owed: amount, treasury and memo are read from the booking row, the request names the payer and nothing else, and the API never sees a key or a signature. The page re-parses the returned transaction before the wallet is asked (payer = fee payer, exactly [system transfer to the treasury of the right lamports, memo], legacy format, one signer) and refuses anything else; `TWENTY_CONFIG.TREASURY` pins the destination independently of the API. Whether a payment counts is still decided by the billing poll reading the chain. The wallet picker reads public addresses only; a disconnect clears the live role and the wallet from page state.
- **Web push.** A subscription is public-event plumbing: no wallet or signature is needed, nothing private is
  ever pushed (no memos, no keys), and a subscription is removed by whoever holds its endpoint. Endpoints must be
  https on a known push service (Google, Mozilla, Apple, Microsoft, Opera, Samsung) unless the operator opens
  it, and still pass the SSRF guard; payloads are capped; the service worker shows only what it was sent and opens
  only same-site or https URLs. The VAPID private key lives in the environment of `bot` and `api` only.
- **Votes / waitlist.** One per wallet or per peppered IP hash; the IP itself is never stored.
- **Process.** `/health` (liveness) and `/ready` (database ping); `SIGTERM` drains connections and closes the
  pool; `TRUST_PROXY` is off unless you terminate TLS on a proxy you control.

## Scheduler (`packages/api/src/jobs`)

- One advisory lock per job, so replicas never run the same job twice; every run is recorded in `job_runs`
  (success, failure and detail) and shown at `/v1/status`. Failed runs retry after five minutes, interrupted
  runs are recovered at start-up, and no job can starve another (they run concurrently).
- Every step is idempotent: re-running lifecycle, snapshots, scores or season close on the same data changes
  nothing. Penalties and status changes are written in transactions together with their public decision row
  and event, so the record can never show one without the other.
- The demo route `POST /demo/pay` exists only in `npm run demo` (`src/demo.ts`); the production server does
  not register it.

## Scanner (`packages/scanner`)

- Every Helius call has a 10 s timeout and up to three retries with jittered backoff on 429/5xx; redirects are
  errors; addresses, cursors and type filters are validated before they are put in a URL.

## Bot (`packages/bot`)

- Webhook delivery goes through the shared SSRF guard and signer (above). `/seat` accepts only 1–20. Shuts
  down cleanly on `SIGTERM`. Keys DM'd to Telegram are removed from the `events` payload once delivered.

## Program (`program/`)

- **Every PDA is re-derived on use.** A ban proposal can only be executed against the seat tenure it was
  opened for (`seeds = [ban-proposal, seat, assigned_at]` plus the holder stored on the proposal); the pad is a
  singleton by seed; a developer's `BanRecord` is derived from the wallet, so a banned wallet cannot be re-seated.
- **Who can do what.** Assignments, scores, suspensions, replacements and election results: the oracle.
  Proposals and approvals: committee members, one signature each, 3 of 5 within 24 h. `execute_ban`: the oracle,
  after 3 approvals. Recall: 11 of 20 seat holders. Expiry: anyone.
- **No money to steal.** The program holds no bond, no escrow and no pool; there is no payout path, so there is
  no Merkle claim, no bitmap and no protection-pool arithmetic to get wrong. Account rent is the only value.
- **Checked arithmetic everywhere** (`checked_add/sub`, `saturating_sub` for fines), `overflow-checks = true`.
- **Clean vacancy.** A banned or replaced seat forgets holder, score and inputs hash, so the next developer starts with a clean record.
- **Rent goes back to the proposer** when an unsigned proposal expires.
- Verified with `cargo check` (Anchor 0.30.1). `initialize` is restricted to the program's upgrade authority (ProgramData check), so the committee and oracle cannot be chosen by a front-runner. Still to do before mainnet: an external audit, a full
  `anchor test` suite on a local validator, and `anchor keys sync`.

## Infrastructure

- Containers run as a non-root user under `tini`, with pruned dependencies, `read_only` filesystems, all
  capabilities dropped, `no-new-privileges`, and health checks on `/ready`. Ports bind to `127.0.0.1` only; a
  TLS-terminating proxy in front serves the headers in `infra/nginx-headers.conf`.
- Secrets live in the environment (`.env.example` lists every one). `KEY_PEPPER` is set once; rotating it
  invalidates issued keys unless they are re-issued.

## Reporting

Write to security@cadre-us.org with steps to reproduce. Bounties follow §11 of the rulebook (2 SOL for a
flag the committee upholds) until a formal programme is published. Please do not test against production
wallets or file test ballots in a live season.
