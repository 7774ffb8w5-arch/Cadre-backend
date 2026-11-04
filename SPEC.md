# Cadre — rulebook as specification (v2)

> **v2 (Nov 2026):** no bond, no escrow, no slashing. Seats are vetted and ranked on a public daily leaderboard; malicious conduct ends in a permanent ban from the platform. The site, API, scheduler and Anchor program implement this version (backend v34).

Normative. The site, `@twenty/shared`, the API and the program implement exactly this. Where code and
this document disagree, this document wins and the code is a bug.

## §1 Seats and slots
- Exactly **20 seats**. Seats are never sold, leased or transferred.
- **Free launch times.** A seat holder books any whole minute (UTC), **≥ 48 h** ahead, shown publicly at once. No daily quota and no fixed hours; announced launches are kept **≥ 2 h** apart.
- A seat with a launch inside its first **14 days** (lock) cannot book. Every launch is **scored at day 30**.
- Hard ceiling: **60 launches per 30-day season**; a seat may use **3 slots a season** (tenured seats 4), one open booking at a time.
- A booking is held **2 hours** for the 3 SOL fee (paid by memo transfer, matched automatically); unpaid it expires. The launch must be created by the seat wallet inside **−5 … +60 min** of the slot, or the slot counts as missed (§7). Cancelling with ≥ 24 h notice frees the slot, the fee stays.
- The pad registers a launch it finds on chain for a booked slot by itself; the developer completes the disclosure within 24 h.

## §2 Vetting
1. **On-chain review** — ≥ 3 prior launches with public wallets; the four pre-checks (§12) over every one of them.
2. **Committee interview** — identity verified privately; never published, never stored (only `identity_verified_at`).
3. **Public review** — 72 h; anyone may file a flag with on-chain evidence (§11). Then the applicant joins the bench, ranked by pre-check score.

## §3 No bond
- There is **no bond, no escrow and no deposit**. Vetting is free; a seat is earned and kept by ranking well on the public leaderboard (§5).
- **Malicious conduct ends in a ban** (§7): the developer and every linked wallet are barred from the platform for good, the seat is vacated the same day. A ban does not repay holders.
- A seat replaced for performance returns to the bench with the record intact.

## §4 Seat score
Daily, from settled launches of the last two seasons. Integer 0–100.

| Component | Definition | Weight |
|---|---|---|
| Survival | share of launches above launch cap at day 30 | 30 % |
| Holder outcome | share of day-30 holders at or above their entry price | **35 %** |
| Peak performance | median peak multiple; 10× = 100 | 20 % |
| Conduct | 100 clean, −25 per warning, 0 if banned | 15 % |

Every daily write publishes its inputs (`/v1/seats/:seat/inputs`) and their sha256 on chain.

## §5 Seasons and replacement
- Season = 30 days. Replacement window = last 72 h.
- **On notice**: bottom two at season close, or score < 40 at any time.
- Bench developers may **signal** a challenge any time (public, free) and **file** one in the window with public evidence.
- **Holder signal**: holders of the incumbent's last three launches vote keep/replace, weighted by position at snapshot; the committee must address it on the record.
- Committee decides within 24 h, 3 of 5, in public. A failed challenger has a 30-day cooldown on that seat.
- On notice at **two consecutive** closes → vacated automatically.

## §6 Launch standards (verified by the pad before go-live)
Dev allocation ≤ 5 %, linear 30-day vest · all team/insider wallets disclosed before launch · no bundled first-block buys from funding-linked wallets · liquidity locked or burned · slot booked ≥ 48 h ahead · public reports on day 7 and day 30 (late > 24 h = warning).

## §7 Penalties
| Violation | Penalty | Seat |
|---|---|---|
| Dev wallet sells inside the vest | permanent ban from the platform | removed |
| Undisclosed bundle / linked-wallet sniping | permanent ban from the platform | removed |
| Abandoned launch (no reports, channels dark) | warning, 30-day suspension | on notice |
| Missed booked slot without 24 h notice | slot fee forfeited + 5 SOL fine | warning |
| Report > 24 h late | warning (−25 conduct) | — |
| Bottom two / score < 40 | none; back to the bench if replaced | on notice |

## §8 Collusion
Weekly cross-seat clustering (shared funding sources, first-block cross-buys). Two confirmed links between seats → **both** banned and removed. Committee members hold no seat launch above 0.1 % of supply. **Recall**: 11 of 20 seats remove a member at any time.

## §9 Fees and the seat pool
Slot fee **3 SOL** per launch, paid at booking, forfeited if missed. Split: **50 % seat pool** (all 20 seats pro rata by score at season close; notice seats forfeit to the treasury), **50 % treasury**. There is no holder protection pool.

## §10 Tenure
Three consecutive seasons without notice, warning or fine → tenured: one extra slot per season. One warning resets the count.

## §11 Public-review bounty
A flag with on-chain evidence that the committee upholds pays **2 SOL** from the treasury. No evidence → discarded; three discarded flags lock the filing wallet.

## §12 The four pre-checks
`dev_vest_sell` · `first_block_bundle` · `liquidity` · `deployer_cluster` — defined in `packages/scanner/src/checks.ts`. Pre-check score = 100 − 22 per flag − 6 per pad warning. `unknown` never counts as a flag.


## §12 The People's Seat
Seat 20 is elected by the holders every season from the vetted bench. Phases by season day: 1–10 nominations (bench developers declare; the committee confirms eligibility only), 11–20 campaign (statements, hustings), 21–30 polls. Electorate: any wallet that held a launch of the season at the day-20 00:00 UTC snapshot; weight = position at the snapshot, capped at 0.5% of a token's supply per wallet; one wallet, one ballot, movable until the polls close. Tally is published live (weighted and by wallet count) and written on chain at the cut with the Merkle root of the ballots (`write_election_result`). The elected developer posts the standard bond and is subject to every other rule; the seat is defended in the cut like any other.
