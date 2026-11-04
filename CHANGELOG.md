# Changelog

## v37 · No subscriptions
- Removed Scanner Pro / Terminal: API keys, USDC key purchase (`/v1/keys/*`), alert-rule routes and webhooks, key tables (`api_keys`, `key_requests`, `alert_rules`). The scanner, feeds, Web Push and the Telegram bot are free; the only fees are the 3 SOL launch fee and franchise licences.
- Site: pricing tiers, access requests and the subscription sliders and chart are gone; the business model shows launch fees and franchise licences only.

## v36 · Telegram bot
- New commands: /leaderboard, /seat, /next, /live, /bans, /status, /watch, /unwatch, /watching, /alerts, /digest, /mute, /unmute, /stop; command menu set automatically.
- Self-service subscriptions (`tg_subs`), per-seat and per-event; daily digest at 08:00 UTC (`bot_state`). Docs: `docs/BOT.md`. 6 new tests (52 total).

## v35 · Status page
- `web/status.html`: live status of website, API, database, scheduler, Solana RPC, market data, leaderboard, payments, alerts and the program, with 90-day uptime bars, incidents and a discreet SOL price. Linked in the site footer.
- API: `GET /v1/health`, `health` job (every minute), tables `health_state`, `health_daily`, `incidents`. Test added (46 API tests).

## v34 · Backend without bonds
- **Shared:** `FEE_SPLIT` 50/50, no bond tiers, no challenge bond, no payout constants; status `banned`; `SUSPEND_DAYS = 30`; `conductScore` is 0 for a banned seat.
- **Database:** `slashes` / `payout_leaves` replaced by `bans` + `banned_wallets`; seats lose `bond_sol`, `bond_tier_sol`, `topup_deadline` (new `suspended_until`); challenges lose memo and bond, gain `evidence`; ledger accounts are `treasury` and `seat_pool` only; decisions `Slash` → `Ban`, new `Suspend`.
- **Scheduler:** `slashes` job → `bans` job (blocks developer and linked wallets, marks the launch banned, vacates the seat, cancels open bookings; moves no money). Score cron drops tiers and top-ups. Lifecycle ends a 30-day suspension. Season close sends notice-seat forfeits to the treasury.
- **API:** `GET /v1/bans`; `/v1/slashes/:id/claim/:wallet` removed; challenges are free but a filed one needs `evidence`; no `CHAL-` payments; `/v1/wallets/:w` reports `banned`; event `slash` → `ban`, `tier_change` removed.
- **Program:** rewritten as a seat registry that holds no money (`assign_seat`, `write_score`, `set_suspended`, `mark_replaced`, `propose_ban` / `approve_ban` / `execute_ban` with a permanent `BanRecord`, recall, election result). `cargo check` passes.
- **Bot / site client / docs:** updated; tests green (45 API, scanner, shared).

## v33 · No bond, no slashing: ranking and bans
- Removed the seat bond, escrow, slash payouts, holder protection pool and challenge bond from the site, rulebook (SPEC v2), help and marketing. Seats are vetted and ranked on a public daily leaderboard; malicious conduct ends in a permanent ban from the platform. Launch fee split is now 50 % seat pool / 50 % treasury.

## v32 · Free launch times
- Removed the "two launches a day" promise and the fixed 14:00/20:00 UTC hours. A seat holder books any whole minute ≥ 48 h ahead; no daily quota.
- New rule: announced launches at least 2 h apart (`PAD.MIN_SLOT_GAP_MINUTES`). Season ceiling 60, 14-day lock, slot fee and launch window unchanged.
- Calendar: "Book a time" per day; dial shows the next announced launch; /v1/slots lists announced bookings only.

## v31.1
- Slash card (1200x630 PNG + post on X) in the launch drawer of a slashed launch.

## v31 · Launch moment
- Ten seconds before a slot the page stages the launch: countdown, lock opens, CA decodes, board tile pulses. Preview link on the next-launch card while the pad is not live. Off under reduced motion.

## v30.2
- Light theme: stronger grey text and border contrast. Shimmer placeholders while live values load. New Open Graph image (1200x630) in the Cadre look.

## v30 · Polish
- Self-hosted fonts (Space Grotesk, Inter, JetBrains Mono) replace Google Fonts; no external font request.
- One spacing rhythm and card radius, softer hero light, 'Built on' line, '8 rooms' heading fix.

## v29 · Start page tidy
- New plain-language guide right after the hero: three steps, who it is for (trade / build), five words explained.
- Simpler hero sentence. Secondary live panels (72h timeline, escrow strip, oracle, KPIs) folded into a collapsed 'Live data' block.

## v28.1 · Buttons
- Fixed: buttons added later inside modals (e.g. Close) did not close the modal; delegated handler.
- One consolidated button system (radius, heights, primary gradient, focus ring), round close buttons, matching link/copy buttons.

## v28 · Hero
- Larger hero headline, seat-scarcity strip (20 segments), stronger primary CTA, 4-stat row under the hero.

## v25.1 — devnet ready (2026-11-02)
- **`docs/DEVNET.md`**: keys, funding, deploy, environment, services, site, a 11-row rehearsal checklist, known devnet limits, and the list that must be green before mainnet.
- **`AMOUNT_SCALE`** (devnet only): divides every SOL amount (slot fee, bonds, fines, bounty) so a rehearsal fits a faucet; always 1 unless `SOLANA_CLUSTER=devnet`. The program has the matching `--features devnet` (tiers ÷ 100); `cargo check` clean with and without.
- **`npm run devnet:check`** pre-flight: cluster, RPC genesis hash (wrong network is a failure), program deployed and executable, id matches `Anchor.toml`, oracle keypair and fees, secrets, database, VAPID, Telegram; exits 1 on any failure. `--cluster mainnet-beta` runs the same check for production and rejects a leftover `AMOUNT_SCALE`.
- `.env.devnet.example`, `web/config.devnet.js` (TREASURY pin, CLUSTER), `API_ORIGIN=… node web/build.mjs` adds a dev API to the CSP. Tests: 5 more (scale never leaks to mainnet, pre-flight passes/fails as it should).
- **`npm run program:init`**: builds `initialize(committee[5], oracle)` without the IDL, dry run by default, `--send` submits and reads the pad back; compares an existing pad instead of touching it; mainnet needs an explicit flag. Tests: instruction layout, Pad decoding, CLI against a scripted RPC.
- **`initialize` is restricted to the upgrade authority** (program: `program` + `program_data` accounts, `NotUpgradeAuthority` error); the client passes both accounts and checks the authority before sending. `cargo check` clean with and without `--features devnet`. Close to the audit scope: still needs a local-validator test.

## v25 — one tap (2026-11-02)
- **Wallet picker.** Phantom, Solflare, Backpack or any injected Solana wallet; the choice is remembered and the site reconnects silently when the wallet already trusts it. Connecting reads the role from `/v1/wallets/:wallet` (seat holder, bench, committee) and lands in the console; account switches and disconnects update the page; on a phone without a wallet the picker offers "Open in Phantom / Solflare".
- **One-tap payment.** `POST /v1/pay/prepare {memo, payer}` returns the unsigned transfer (system transfer to the treasury + memo) for SLOT-/CHAL- memos — amount, destination and memo come from the database row, the caller only names the payer. The page re-parses the transaction byte by byte (payer, treasury, lamports, memo, exactly two instructions; optional `TWENTY_CONFIG.TREASURY` pin) before the wallet sees it, the wallet signs and sends, `GET /v1/pay/status/:memo` drives a Pay → Sent → Confirmed stepper and the card closes itself. Phone wallets: a Solana Pay QR (`web/qr.js`, checked against an independent decoder) and an "open in wallet" link; the plain address/amount/memo stay one click away.
- **Launch room** (`#room`, `#room-07`): a page per slot. Countdown and a locked box before the slot, "watching the seat wallet" during it, and the contract address, copy button, venues and a one-click pre-check once the pad has registered the token from chain data; missed slots say so. The live pad never shows an invented CA (the preview labels its sample). Push reminders and "launch live" now open the room; the seat holder sees their own checklist.
- Fixes: the old launch-room modal showed a made-up CA on the live site (now removed); the connect button only knew `window.solana`.
- Tests: 5 payment scenarios (tx decodes to [transfer, memo], caller cannot choose amount/destination, status follows the billing poll, expired/paid memos, challenge bond); page: 13 launch-room checks, route list extended; live e2e with a scripted Phantom (connect → role → console, tampered transactions refused, reject → "Cancelled", approve → billing job confirms → console refreshes, disconnect).

## v24 — notifications (2026-11-02)
- **Web push, end to end.** `web/sw.js` (push + click, re-subscribe on rotation) and `web/push.js` (permission, VAPID subscribe, scope, test, off); `POST/DELETE /v1/push/subscribe`, `/v1/push/key`, `/v1/push/test`; `push_subscriptions` table; the bot delivers every matching event (`pushEvent`), deletes gone subscriptions and disables after 20 failures; `shared/push.ts` holds matching, titles and the sender.
- **"Launches in 15 minutes"**: a one-minute `reminders` job emits `slot_soon` once per confirmed slot; seat holders and watchers get it by push, Telegram and webhook.
- **In the UI**: a Notifications card in every console (scope = your seat + watched seats, or every seat; "Send a test", off), "Notify me" on the next launch, the watch star widens the scope automatically, a help article; the preview shows a sample notification, the live site subscribes for real.
- CSP `worker-src 'self'`; demo generates ephemeral VAPID keys, logs pushes at `/demo/pushes`, seeds a 15-minute slot at `/demo/slot-soon`. Tests: 5 push scenarios (validation, scope, reminder, delivery, failures) — 30 in all.

## v23 — the smart layer (2026-11-02)
- **Next 72 hours**: one strip on the overview and above the calendar — booked slots, open slots, report deadlines, the next score write, window/season/election milestones — packed into lanes without overlap, your own events marked; a list with local time on phones.
- **Local time** next to every UTC time that matters (24 h, the viewer's zone), in the console, the strip and the calendar.
- **The bell is personal**: "For you" first (your seat, your launches, watched seats, your role's rulings, your ballot), then "On the pad"; the badge counts only what concerns you; the title says since when.
- **Search understands what you paste**: a wallet or mint → scan it (or open the seat/launch it belongs to) or open it on Solscan; a signature → Solscan; `$TICKER` → the launch room; `seat 7` / `#7` / `7` → the dossier; `help …` → the help centre search; `book`, `vote`, `console` → the action.
- **Task buttons land on the control**: "Book a slot" scrolls to the first bookable slot and flashes it; "Ballot" to the ballot card.
- **Returning wallets open on their console**; first visits on the overview. Applicants see their application's progress in the console.

## v22 — the console (2026-11-02)
- New view `#console` (nav entry, phone tab, key 7, palette, help article): the pad from the wallet's side. Seat holders see score with the 30-day spark, bond vs tier, slots used this season, the next slot with countdown, a task list in order of urgency (fee to pay, bond to top up, report to file, disclosure to complete, slot to book, the zone, the ballot), their launches with report states, and today's score inputs. Bench developers see bench rank, the window, the zone and their Seat 20 poll; committee members what waits for a ruling; any other wallet its watchlist, alert rules, payout claims and ballot. Without a wallet, a role chooser; with the live API, `/v1/wallets/:wallet` fills it and every button is a signed request (pay card straight from the task list, claims checked against every slash, real 6-hour series in the launch room, machine status strip).
- Header: group-button icons only above 1700 px, the header CTA only above 1500 px — the Console entry fits at every width.
- API: `/v1/pad.treasury_wallet`, `/v1/launches[].slashed.id`. Verified end to end in a browser: connect → console → book → pay from the console → confirmed → console shows the launch.

## v21 — the machine (2026-11-02)
- The pad runs server-side, not only in the browser: wallet-signed developer routes (book, cancel, register launch, disclosure, reports, apply, flags, challenges, holder vote, candidacy) and committee routes (propose, vote, 3 of 5 executes), every write a signed request with a nonce and a body hash — no sessions, no keys.
- Scheduler (`jobs/runner.ts`, its own container `jobs`): lifecycle every 10 min (unpaid bookings expire, missed slots fined, launches found on chain are registered, lock → open → settled at day 30 with the holder outcome, report reminders and warnings, disclosure deadline, public review → bench, proposal expiry, top-up suspensions, hygiene), snapshots (30 min for fresh launches, 6 h otherwise, cost-basis holder positions), daily score write 00:05 UTC (+ on chain), season close on day 1 (notice, vacate, tenure, seat-pool distribution, People's Seat result + ballot Merkle root), election snapshot day 20, slashes every 5 min (holder snapshot → Merkle payout → on-chain execute, claim-window sweep), indexer, billing every 30 s (USDC keys, SOL slot fees, challenge bonds). Every run under a Postgres advisory lock, written to `job_runs`, shown at `/v1/status`; failed runs retry after 5 min, interrupted runs are recovered at start-up, jobs run concurrently.
- Oracle client (`oracle.ts`, @solana/web3.js): write_score, mark_replaced, execute_slash, write_election_result when `PROGRAM_ID` + `SCORE_ORACLE_KEYPAIR` are set; otherwise every write is recorded with its inputs hash and signed later.
- Site: `web/dev.js` turns the demo's write flows into signed requests when `API_BASE` is set (pay cards with memo, self-updating confirmation); the connected wallet drives the page's role (seat holder, bench, committee) from `/v1/wallets/:wallet`.
- `npm run demo`: the whole machine on one laptop — in-process Postgres with the production schema, a seeded pad with a record, scripted chain and market, the scheduler, the API on :8080 and a `/demo/pay` route. Verified in a real browser: site with CSP → live feeds → signed booking → memo payment → billing job confirms within 30 s → fee split → log.
- Tests: 13 end-to-end scenarios on a real Postgres (PGlite) with a controllable clock — every rule of §1–§12 from booking to the season cut — plus the 11 security tests and the web/server signing parity test (25 in all, no database needed).
- Infra: `jobs` container, `ENTRY` build arg, `/ready` health checks, `.env.example` for the oracle; docs: API (every route, signed requests), SPEC §1 booking rules, OPERATIONS runbook.

## v20 — hardening (2026-11-02)
- Site: hash-based Content-Security-Policy stamped by `web/build.mjs` (also `_headers` and `infra/nginx-headers.conf`), no inline event handlers, `safeStr()` boundary sanitising in `live.js`, `sanitizeState()` rebuilds stored state into exact record shapes, safe hash routing (`hashOf()`), fetch timeouts and `credentials: omit`. Suite: no errors, no overflow at six widths × two themes × eleven routes; poisoned storage and hostile hashes never reach the DOM; zero CSP violations with the policy enforced.
- API: JSON schemas on every route, 64 KiB body limit, helmet, fixed CORS (`["*"]` never matched), one error handler (no stack or SQL leaves the process), redacted logs, peppered key hashes with transparent upgrade, atomic quota, claim token for key collection (the memo is public), SSRF-guarded + signed alert webhooks with list/delete and per-tier caps, constant-time webhook secret (required), signed ballots with nonce + 10 min window + snapshot eligibility, `/ready`, graceful shutdown, `TRUST_PROXY`. Eleven tests in `packages/api/test/security.test.ts` run without Postgres.
- Scanner: Helius client with timeouts, bounded retries with jitter, input validation. Bot: shared SSRF guard at delivery, 5 s timeout, no redirects, HMAC signature, failure counter, `/seat` validation, clean shutdown.
- Program: proposals bound to their seat tenure and bitmaps to their payout by PDA seeds, oracle-only execution after 3 approvals, protection share capped, checked arithmetic, bounded pot, clean vacancy, rent back to the proposer, `write_election_result`. `cargo check` clean.
- Schema: `launch_holder_outcomes` (the cron referenced it), `election_snapshot`, `election_nonces`, `key_requests.claim_hash`, `alert_rules.secret/failures`. Infra: non-root containers under tini, read-only, no capabilities, localhost-bound ports, health checks. New `docs/SECURITY.md`.

## v19 — soft premium (2026-11-01)
- One radius system (10 px panels, 6 px controls, pill chips, 7 px tiles), soft depth on cards, table row hover, lighter rhythm on alternate sections, kicker icons, reading progress line, body text 16 px, labels never under 11 px, 42 px tap targets on phones.
- Light theme: the emblem always sits on a graphite plate; the kit's light emblem uses the dark gold stops.

## v18 — icons + help centre (2026-11-01)
- One glyph per section and view (24-grid, 1.7 stroke): desktop dropdowns and group buttons, view bar pills and switches, mobile sheet, palette rows, footer links.
- Help centre as its own view (`#help`): eight chapters, 29 articles (start here, traders, developers, governance, data & API, account & app, safety, glossary), search, sticky table of contents with scrollspy, copy-link per article, deep links `#h-<slug>`, every article linked to the live part of the pad. Also exported to `docs/HELP.md`. Reachable from Learn, the view switcher, the mobile sheet, the footer and the `?` overlay.

## v17 — the noble pass (2026-11-01)
- Editorial typography: headlines (h1, section titles, CTA band, ring, map doors) in Cormorant Garamond, sentence case, tighter leading; display numerals stay in Big Shoulders. Larger lede, wider-tracked kickers.
- Air and ornament: more section spacing on desktop, a hairline with a brass lozenge where sections meet, tracked-caps CTAs in the hero and band, calmer surfaces and motion, tighter mobile banner.

## v16 — the people's seat (2026-11-01)
- Seat 20 is elected by the holders (§12): election section in The Cadre view with phase clock (nominations · campaign · polls), four vetted candidates with statements, live weighted tally and wallet counts, cast/move/withdraw ballot, turnout, current holder, ballot card (PNG + X). Rulebook §12, seat-20 mark on roster and dossier, overview door, palette entry, wire/log event, banner when polls are open.
- API: `GET /v1/election`, `POST /v1/election/ballot`, `GET /v1/election/ballots/:wallet`; schema: `elections`, `election_candidates`, `election_ballots`.

## v15 — six views (2026-11-01)
- Information architecture: one product, six views — Overview (hero, map, pitch), The Cadre (roster, standings, the cut, bench), Launches (calendar, trade), Trust (committee, treasury, protocol, log, rulebook), Tools (scanner, feeds, pricing, kit), Learn, Apply. Hash routes `#pad #launches #trust #tools #learn #apply`; section ids route to their view and scroll; seat-/launch- links still open drawers. The overview is ~5,000 px instead of ~27,000.
- Map section on the overview: eight doors with live lines. Sticky view bar under the header with section pills and view switches; group buttons in the desktop nav open their view; keys 1–6 switch views.
- Fixes: horizontal panning on phones (`overflow-x: clip` on html/body, `touch-action: pan-y` on body, sections clipped), Built-for cards were clipped to 28 px by a class collision since v11.

## v14 — premium pass + the cut (2026-11-01)
- Premium pass: flow-field hero background (liquidity currents), glass panels with gradient borders (season, live/next, ring, modals), border beams on the live/next cards, frosted header, glowing numerals, section numbering, tape edge fades, glass secondary buttons.
- Telemetry HUD under the trust strip: RPC latency sparkline, deployer-index counter, oracle countdown, escrow signatures, scanner count — labelled sample telemetry.
- The cut (new section after standings): replacement day live — the two lowest seats vs the bench, threshold/window/committee, holder signal with keep/replace, challenges when the window is open, the four steps. Linked from the Pad menu and the palette.

## v13 — collectibles + PWA (2026-11-01)
- Membership card (1200×750, card format) per seat: guilloche, chip, deployer wallet as card number, bond/score/tenure, emblem; from the seat dossier. Save PNG + post on X.
- Launch announcement card (1200×630) per booked slot: date/time in gold, seat, grade, bond, "CA drops at the slot" — from the next-launch card, the launch room and the calendar.
- PWA: `web/manifest.webmanifest`, icons (192/512/maskable/apple-touch) from the coin, emblem-1024.png; add-to-home-screen ready.

## v12 — the emblem (2026-11-01)
- Emblem: heavy "CADRE" in bevelled, lit gold with a laurel wreath, glow and a looping sheen (pure SVG: gradient + specular lighting filter). Splash on first visit per session (draw-in sequence, skippable), emblem crowns the season card and follows the cursor (light + tilt), seals on recap/receipt/share cards, footer, kit X header and avatar; `web/brand/the-20-emblem*.svg` added.
- Mark: heavy numeral everywhere (header in metal gold with the UTC dot, favicon coin, badge, card headers).

## v11 — CADRE (2026-11-01)
- Logo v5 "CADRE": a bespoke geometric numeral drawn as paths — monoline 2, elliptical 0 carrying the dial (20 notches, 2 lozenge indices), small "THE" above. Lockups stacked / mono / coin; metal gradient for coins and large marks; the header mark draws itself in on load and a dot walks the zero with UTC time. Favicon, badge, cards, kit, X header, avatar, footer updated; `web/brand/*.svg` added.

## v9 — the seal (2026-11-01)
- Logo v4 "the seal": hairline double ring, twenty fine notches on the track, lozenge indices at the slots, serif "20" (Cormorant Garamond), coin with a metal gradient, seal variant with ring text for large uses. Wordmark lighter and wider-tracked. Favicon, badge, cards, kit, footer updated.
- Launch chart: gradient area, glow line, protocol markers (d7 report, lock end, settle), crosshair with multiple pill.
- Launch room: a live dial counts the arc down to the slot.
- Fixes: kit logo boxes wrap on phones; brand width at 1024.
- Hero: the art dial follows the seal (hairline rings, lozenge indices, serif 20); headline accent word set in Cormorant Garamond italic; light-mode gradient darkened.

## v8 — brand + instruments (2026-11-01)
- Logo v3: the dial. 24-hour face, noon on top, 20 seat notches, two slot ticks at 14:00 and 20:00 UTC, "now" dot that walks the ring in the header. Line + solid coin variants, SVG (`logoSvg`) and canvas (`drawLogoCanvas`) twins; every card, the badge, the kit header/avatar and the favicon use it.
- Hero art: the gate is a live dial (hand, arc to the next slot, seat notches in status colours); streams leave from the slot ticks.
- The Ring (roster): twenty seats on the dial, bar = score, colour = grade, dashed ring = notice threshold, live pulse; hover/tap for the seat line, click opens the dossier. Seat drawer shows the seat's position on the dial.
- Instruments: wire feed in the season card, mini dial in the next-launch card, system bar above the footer, keyboard shortcuts (`?`), 3D tilt + glare on cards, hero grain, parallax grid, scroll reveal, footer wordmark.
- Fixes: tablet header fit (CTA/demo hidden 761–920px), recap title fits any font, scan score fits, card headers no longer paint a box.

## v26 · Cadre
- Renamed from "The Twenty" to **Cadre** (page, API strings, push, bot, signed-message prefix, Solana Pay label, docs). Internal package/program names (`@twenty/*`, `twenty`) are unchanged.
- New logo: folded "C" in three planes (white, fold, violet) with the CADRE wordmark; emblem, coin, favicon, app icons, OG image and brand files regenerated (`web/brand/cadre-*.svg`).
- New colour scheme: black / white / violet replaces brass-gold in both themes.
- The signed-message prefix changed ("Cadre · <action>"); clients must use the new page build.
- Start sequence (v26.1): pure CSS and present from the first paint, so the page never flashes before it. A line of light scans the mark into view (a backdrop-coloured cover slides with it, so only transform/opacity move and the reveal stays smooth while scripts parse), the bloom sits above in screen blend, the wordmark tracks in letter by letter, one soft light pass, then the page follows and its own marks settle in. Skip button, `prefers-reduced-motion` off switch, once per session (`twenty-intro`).
- Landing: background grid, flow canvas and grain removed for a clean surface in both themes.
- Page structure: `<title>` and the styles now sit in `<head>`; the splash is the first element of `<body>`. The splash skip button no longer shares a class with the skip-to-content link.
