# Help centre

The same articles as the site's help view (`#help`). Values come from the rulebook constants.

## Start here

### What Cadre is

Cadre is a Solana launchpad with exactly twenty developer seats. Only a seat can launch here, and every launch is announced at least 48 hours ahead, at a time the developer picks. Every seat holder passed vetting and is scored and ranked every day on what their launches did for the people who bought them.
The idea in one line: on an open launchpad thousands of tokens a day compete for the same liquidity and nobody is accountable; here a few announced launches get all of it, and the developer has something to lose: their place. If a developer breaks trust, they are banned from the platform and the seat goes to the next developer on the bench.
Cadre is a software company. It sells launch bookings and data, never tokens. It never holds your funds and never routes your trades.

See: Why it works (#why) · Open launchpad vs. Cadre (#compare) · Rulebook (#rules)

### The console

The console (#console) shows the pad from the wallet's side. A seat holder sees score, rank, slots, launches and a task list — fee to pay, report to file, disclosure to complete, slot to book, the zone. A bench developer sees the window, the zone and their candidacy. A committee member sees what is waiting for a ruling. Any other wallet sees its watchlist, alert rules and the Seat 20 ballot.
Without a wallet, "Preview as" shows each console with the demo state of this browser. With the live API, /v1/wallets/:wallet fills it and every button is a signed request.

See: Open the console (#console) · Connecting a wallet (#h-wallet) · How the machine runs (#h-status)

### A 60-second tour

- Overview — the headline numbers: the live launch, the next slot with its countdown, the trust strip, the board of twenty tiles (green dot = launch live, amber = on notice).
- The Cadre — the roster with every seat's dossier, the ring (scores on the dial), the standings with projections, the cut (who is in the replacement zone), the People's Seat election and the bench.
- Launches — the 7-day calendar, the pipeline, the ledger of every launch with multiple, ATH, holders and reports, and the trader workflow.
- Trust — committee decisions, treasury and pools, the on-chain protocol, the public log and the rulebook.
- Tools — the scanner, feeds and alerts, pricing, the media kit.
- Learn and Help — the arithmetic behind twenty, the FAQ, and this centre.
Keyboard: 1–6 switch views, ⌘K searches everything, ? lists every shortcut.

See: Overview (#top) · The Cadre (#roster) · Launches (#launches)

### Reading the overview

- Live now — the youngest launch inside its 14-day lock: multiple from launch cap, ATH, holders, dev allocation and vesting, LP status and a live check of the dev wallet.
- Next launch — the next booked slot, the seat's dossier in miniature, the mini dial counting down, and the launch room where the contract address appears at the slot.
- Trust strip — vetted seats, undisclosed wallets (always zero by rule), bans, CAs pre-checked.
- Telemetry — RPC latency, the deployer index, the oracle's next write, scanner volume. Sample data in this preview; live feeds on mainnet.
- The board — twenty tiles. Tap any tile for the seat's dossier.
- The map — eight doors into the product, each with a live line.

See: Overview (#top)

## For traders

### How a launch day works

Slots are booked at least 48 hours ahead, so you always know who launches when. The seat's dossier, grade, rank and record are public before the slot; the ticker and contract address are not. At the slot they appear in three places in the same second: the launch room on the site, the seat page, and the alert channel.
- Before the slot — read the dossier, set an alert, add the slot to your calendar, post the announcement card if you want.
- At the slot — the CA drops. Verify it with the scanner badge before you buy; anything claiming to be this launch earlier is not it.
- Day 0–14 — the lock. The seat cannot launch again; the launch chart, holders and reports are tracked daily.
- Day 7 and day 30 — the developer files reports. Late or missing reports are warnings on the record.
- Day 30 — the launch settles and counts into the seat's score.

See: Calendar (#launches) · How to trade a launch (#trade)

### Reading a seat dossier

Open any seat from the board, the roster, the ring or the standings.
- Grade and score — A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 40, F below. Score is 0–100 and written daily by the oracle from four inputs: survival at day 30 (30%), holders at or above entry (35%), median peak multiple (20%), conduct (15%).
- Rank and 30-day change — position among the twenty and the trend.
- Leaderboard — all twenty seats ranked by score, updated daily and public.
- Record — warnings, fines, notices; clean streak in launches.
- Launches — the last 45 days with multiple, peak, holders and reports; open one for the chart.
- Share and membership cards — PNGs that carry the seat's public record.

See: Roster (#roster) · Standings (#standings)

### What protects you

One rule stands behind every launch.
- The ban — a dev wallet sale inside the 14-day vest, an undisclosed insider wallet, a bundled first block or collusion between seats ends in a permanent ban from the platform: the committee votes on the record within 24 hours and the seat is vacated.
- The leaderboard — every seat is ranked in public every day, so weak launches cost a developer their place.
A ban removes the developer; it does not repay holders. The pad reduces rug risk, not market risk: a launch can still trade down with no rule broken.

See: Treasury and pools (#treasury) · How a ban works (#protocol) · Rulebook §6–§8 (#rules)

### Trading a launch

The pad does not route trades. Every launch card links to the venues (pump.fun, DexScreener, GMGN, Axiom, Jupiter) with the verified contract address; you trade where you always trade.
- Copy the CA from the site or the alert channel only.
- Read the launch chart: launch cap line, d7 report, lock end, settle markers; hover for the multiple at any point.
- Insiders are listed before launch with their percentage; dev allocation is capped at 5% and vests 30 days.
- Set an alert for the seat — slot booked, launch live, report due, ban — to Telegram or a webhook.

See: Trader workflow (#trade) · Alerts (#data)

### Using the scanner

Paste any deployer wallet or token mint. The scanner runs the four checks the committee runs first: dev wallet sales inside the vest, bundled buys in the first block, liquidity locked or burned, and funding-linked deployer clusters — plus the pad record if the address belongs to a seat. You get a 0–100 pre-check score, a grade, and a card to post.
Free for everyone, no account and no key. Results are cached for 6 hours.

See: Scanner (#scanner) · Pricing (#business)

### Feeds, alerts and the calendar

- Feeds — open JSON for the pad, seats, slots, launches, scores and the log, no key, 60-second refresh. Copy the URLs from the data section.
- Alerts — build a rule (all seats, one seat, or your watchlist × events) and deliver it to Telegram or a webhook.
- Calendar — every slot shows UTC and your local time; add a slot to Google Calendar with one tap; the launch room opens two hours before.
- Embed — a 360×190 widget shows the next launch on your own site.

See: Feeds and alerts (#data) · Calendar (#launches)

### Browser notifications

The pad can notify this browser — no wallet, no account, nothing to install on a computer. On a phone, add the pad to the Home Screen first (iPhone needs that for push). Turn it on in the console or with "Notify me" on the next launch.
- Seat holders get their slot 15 minutes before, report deadlines, zone changes, challenges and decisions on their seat.
- Everyone else gets the seats they watch: slots 15 minutes before, launches going live, reports due, zone changes and bans — plus season close and the Seat 20 result.
Watching more seats widens the scope automatically. "Send a test" shows what a reminder looks like. Turn it off any time; the pad deletes the subscription.

See: Console (#console) · Feeds and alerts (#h-alerts) · Install the app (#h-install)

### The launch room

Every slot has a room at #room (or #room-07 for Seat 07). Before the slot it shows a countdown and a locked box: the contract address appears only once the pad has seen the token created by the seat's own wallet, so an address posted anywhere earlier is not the launch.
- Slot open — the pad is watching the seat wallet; the page updates itself.
- Live — the CA, a copy button, the venues and a one-click pre-check.
- Missed slot — no token inside the window; the rulebook's missed-slot penalty applies.
Push reminders open the room 15 minutes before the slot. Turn them on with "Notify me".

See: Open the room (#room) · Browser notifications (#h-push) · Scanner (#scanner)

### Cards you can post

Every important moment has a 1200×630 card (or 1200×750 for the membership card) rendered on the spot with live numbers: the seat share card, the membership card, the launch announcement card, the scan card, the rug receipt, the season recap, the ballot card. Save the PNG or post straight to X. Numbers are as of now; the card says so.

See: Media kit (#brand)

## For developers

### Who can apply

Any developer with a public deployer wallet and at least three launches on the record. There is no fee to apply and no deposit, ever. What matters is the record: survival of your launches, how holders did, whether your dev wallet behaved inside the vest, whether your liquidity was locked or burned, and whether your deployer is clustered with wallets that rugged.

See: Apply for a seat (#apply)

### The four steps

- On-chain pre-check — paste your deployer and your mints; the scanner runs the four checks in public.
- Interview — a committee member walks through your worst launch with you. Identity is verified for the record and never published.
- 72-hour public review — your application is on the site; anyone can file a flag with on-chain evidence (a 2 SOL bounty if upheld).
- Bench — pass, and you wait in line by pre-check score. When a seat opens you take it; your first launch is bookable 48 hours later.

See: Apply (#apply) · Bench (#bench)

### Fees and bans

- No bond — seats are earned through vetting and kept by ranking well. Nothing is locked.
- Launch fee — 3 SOL per launch, split 50% seat pool (paid back to seats by score) and 50% treasury.
- Missed launch — fee forfeited and a 5 SOL fine.
- Leaving — replaced for performance: you return to the bench with your record. Banned: permanent, from the whole platform. A clean exit (announced, settle awaited) keeps your record.

See: Treasury (#treasury) · Rulebook §3 (#rules)

### Booking and launching

- Book at least 48 hours ahead; pick any minute of the day (UTC), at least 2 hours from another announced launch; one launch per seat per 14-day lock; hard ceiling 60 launches per season.
- Before the slot: disclose every team and insider wallet with its percentage; dev allocation ≤ 5% with a 30-day vest in the program vault; LP burned or locked.
- Never publish the CA before the launch time. The room, the seat page and the alert channel publish it at the same second.
- File the day-7 and day-30 reports on time; more than 24 hours late is a warning.

See: Calendar (#launches) · Rulebook §1, §6 (#rules)

### How the score works

Every day at 00:00 UTC the oracle writes a score for each seat from its settled launches of the last 90 days: 30% survival at day 30, 35% holders at or above entry, 20% median peak multiple, 15% conduct (warnings, fines, late reports). The inputs are published with a hash so anyone can recompute it.
Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 40, F below 40. A seat under 40, or in the bottom two at season close, is on notice.

See: Standings (#standings) · Protocol (#protocol)

### Tenure, notice and the cut

- Tenure — 3 consecutive seasons without a notice, warning or fine: one extra slot per season and a longer record on the leaderboard. One warning resets the count.
- Notice — the bottom two seats at season close (and any seat under 40) are in the replacement zone. A seat on notice can be challenged.
- The cut — the replacement window opens 72 hours before season end. Bench developers file, holders of the seat's last three launches signal keep or replace, the committee confirms on the record. The seat hands over on day 1 of the next season.
- Challenges — a bench developer files a challenge against a seat on notice with public evidence; the committee decides on the record within 24 hours.

See: The cut (#cut) · Rulebook §4, §5, §10 (#rules)

### Warnings, fines and bans

- Warning — late report, missed disclosure, missed launch: −25 conduct, on the record.
- Fine — 5 SOL for a missed launch.
- Ban — dev wallet sale inside the vest, undisclosed insider wallet, bundled first block, collusion, or a mint created outside the launch time: the committee votes within 24 hours, the seat is vacated and the developer is banned from the platform for good, with every linked wallet.
Every decision carries the vote and the evidence in the public log.

See: Committee (#committee) · Public log (#log)

## Governance

### The committee

5 members with public wallets, fixed terms and declared focus areas (on-chain review, wallet clustering, holder outcomes, launch standards, interviews). They confirm seats, decide warnings, fines, bans and challenges, and confirm eligibility for the People's Seat — never its winner. Every vote is on the record. Holders can file a recall against a member with evidence.

See: Committee (#committee)

### The People's Seat

Seat 20 is elected by the holders every season from the vetted bench (§12). Phases: nominations (day 1–10), campaign (11–20), polls (21–30). Any wallet that held a launch of the season at the day-20 snapshot can vote; weight is position at the snapshot, capped at 0.5% of a token's supply per wallet; one wallet, one ballot, movable until the polls close. The tally is published live and published at the cut. The winner follows every other rule.

See: Vote (#wildcard) · Rulebook §12 (#rules)

### Treasury and the public log

Every SOL that moves — launch fees, pool payouts and fines — is a line in the ledger with its transaction. The treasury funds operations and bounties; the seat pool pays seats by score at season end; the public log lists every event the pad emits: bookings, launches, reports, decisions, ledger entries, challenges, ballots.

See: Treasury (#treasury) · Public log (#log)

## Data and API

### Public feeds

No key needed: /v1/pad, /v1/seats, /v1/seats/:seat/inputs, /v1/slots, /v1/launches, /v1/launches/:mint/snapshots, /v1/log, /v1/election, /v1/scan/:address (cached). Everything the site shows comes from these feeds, so what you build matches what traders see.

See: Feeds and alerts (#data)


### Verification badge and embed

Seats and launches have an SVG badge that links back to the verified record; terminals verify it through /v1/verify/:mint. The embed widget shows the next launch on your own page. Both are in the media kit with copy-paste snippets.

See: Media kit (#brand) · Embed (#data)

## Account and app

### Wallets, roles and what is stored

This preview runs on sample data. Connecting a wallet stores nothing on a server: your role preview, watchlist, alerts, signals, ballots and scans live in your browser only, and the demo switch lets you preview the pad as a visitor, a seat holder or a bench developer. On mainnet, voting and challenges sign a message with your wallet; the pad never asks for a transaction except to pay a launch fee.

See: Overview (#top)

### Keyboard shortcuts

Search · command palette⌘ K
This overlay?
Overview · The Cadre · Launches · Trust · Tools · Learn1 – 6
LaunchesL
The rosterS
Launch room · next launchN
Apply for a seatA
Scanner · pre-check a CAC
Toggle themeT
Close drawer or modalEsc

### Install as an app, themes, accessibility

- Install — on iPhone: Share → Add to Home Screen; on Android and desktop Chrome: the install prompt in the address bar. The app opens full screen with the coin as its icon.
- Theme — the sun/moon button in the header; your choice is remembered on this device.
- Motion — with “reduce motion” set in your system, the start sequence, the tilt and the reveals are off.
- Keyboard — every control is reachable by tab; the skip link jumps to the content.

## Safety

### Fakes, phishing and what we never do

- The CA appears only at the slot, on this site and on the alert channel. A CA posted earlier is not the launch.
- We never DM first, never ask for seed phrases, never sell tokens, never hold funds and never route trades.
- Every official link is in the footer. Check the domain before connecting a wallet.
- Verify any badge through the scanner; a badge image without a verified link proves nothing.
- Seen something wrong on a launch or an application? File a flag with on-chain evidence — upheld flags pay a 2 SOL bounty.

See: File a flag (#bench) · Scanner (#scanner)

### Status and incidents

The system bar at the bottom of every page shows the build, the oracle's next write, the SOL feed and the scanner. Incidents are posted in the public log with their resolution. If the oracle misses a write, scores stay at the last value and the day is marked; no seat can go on notice from a missed write.

See: Public log (#log)

## Glossary

### Glossary A–Z

**Bench** — Vetted developers waiting for a seat, ranked by pre-check score.
**Ban** — Permanent removal from the platform after a confirmed trust break; seat vacated.
**Leaderboard** — All twenty seats ranked by score, public and updated daily.
**CA** — Contract address of a token; on this pad it appears only at the slot.
**Clean exit** — An announced departure after the last launch settles; record kept.
**Cut** — The replacement at season close: the bottom two seats and any seat under 40.
**Dossier** — A seat's public page: score, rank, record, launches, cards.
**Grade** — A–F from the score: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 40.
**Lock** — The 14 days after a launch in which the seat cannot launch again.
**Notice** — Status of a seat in the replacement zone; challenges allowed.
**Oracle** — The signer that writes daily scores on chain with hashed inputs.
**People's Seat** — Seat 20, elected by the holders every season.
**Report** — The developer's day-7 and day-30 statement on a launch.
**Seat pool** — 50% of launch fees, paid back to seats by score at season end.
**Season** — 30 days; scores freeze on day 30, the cut follows.
**Slot** — The launch time a seat holder books, at least 48 hours ahead. Any time of day.
**Tenure** — Three clean seasons; extra slot, longer record.
**Vesting** — Dev allocation locked in the program vault for 30 days.
**Zone** — The replacement zone: the seats that leave at the cut unless they climb.
