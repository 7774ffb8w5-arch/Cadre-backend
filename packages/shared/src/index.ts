/**
 * @twenty/shared — the rulebook as code.
 * Every number here mirrors docs/SPEC.md and the public site. Change it in one place.
 */

/**
 * Devnet rehearsals cannot fund 3 SOL slot fees, so `AMOUNT_SCALE=100` divides every SOL amount by 100 — but only
 * when `SOLANA_CLUSTER=devnet`. On mainnet (or with nothing set) the scale is always 1, whatever else is in the
 * environment. The program has the matching `devnet` feature (amounts ÷ 100).
 */
export function amountScale(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): number {
  if (env.SOLANA_CLUSTER !== "devnet") return 1;
  const n = Number(env.AMOUNT_SCALE); return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}
const SCALE = amountScale();

export const PAD = {
  SEATS: 20,
  MIN_SLOT_GAP_MINUTES: 120,   // two announced launches never overlap: each gets its own window
  BOOK_AHEAD_HOURS: 48,
  LOCK_DAYS: 14,
  SETTLE_DAYS: 30,
  SEASON_DAYS: 30,
  REPLACEMENT_WINDOW_HOURS: 72,
  SEASON_CEILING: 60,
  THRESHOLD: 40,
  SLOT_FEE_SOL: 3 / SCALE,
  FEE_SPLIT: { pool: 0.5, treasury: 0.5 },   // no bond, no protection pool
  SUSPEND_DAYS: 30,                          // abandoned launch → warning + this suspension
  BOUNTY_SOL: 2 / SCALE,
  TENURE_SEASONS: 3,
  COMMITTEE: { members: 5, threshold: 3, banWindowHours: 24, recallSeats: 11 },
  DEV_ALLOCATION_MAX_PCT: 5,
  VEST_DAYS: 30,
  /** §12 People's Seat: days 1–10 nominations, 11–20 campaign, 21–30 polls; snapshot on day 20; one wallet ≤ 0.5 % of supply */
  ELECTION: { nominationDays: 10, campaignDays: 10, snapshotDay: 20, voteCapPct: 0.5, minHoldPct: 0.0001 },
  /** §1/§10: 60 launches ÷ 20 seats = 3 slots per seat per season; a tenured seat gets one more */
  SLOTS_PER_SEASON: 3,
  TENURE_EXTRA_SLOTS: 1,
  /** §7: a booked slot counts as missed when no launch is registered this long after it; cancelling closer than 24 h is a miss too */
  MISSED_SLOT_GRACE_MIN: 60,
  CANCEL_NOTICE_HOURS: 24,
  MISSED_SLOT_FINE_SOL: 5 / SCALE,
  /** unpaid bookings hold a slot this long */
  BOOKING_PAY_WINDOW_MIN: 120,
  /** §5 challenges are free but need public evidence; a failed one blocks the same challenger for this long */
  CHALLENGE_COOLDOWN_DAYS: 30,
  /** §6 reports: late by more than this = warning */
  REPORT_GRACE_HOURS: 24,
  /** a mint created earlier than this before its slot is a "CA before launch" breach */
  LAUNCH_EARLY_TOLERANCE_MIN: 5,
  LAUNCH_LATE_TOLERANCE_MIN: 60,
  /** §2: at least this many prior launches to apply */
  APPLY_MIN_LAUNCHES: 3,
  PUBLIC_REVIEW_HOURS: 72,
  FLAG_DISCARD_LOCK: 3,
} as const;

/** §6/§7 — the state of a report given its filing time (mirrors report_state() in the schema). */
export function reportState(filedAt: number | null, dueAt: number, nowMs = Date.now()): "due" | "filed" | "late" | "missing" {
  const grace = PAD.REPORT_GRACE_HOURS * 3_600_000;
  if (filedAt == null) return nowMs > dueAt + grace ? "missing" : "due";
  return filedAt > dueAt + grace ? "late" : "filed";
}

/** The booked slot a timestamp belongs to, if it is inside the launch window of one (−5 min … +60 min). Slots are chosen by the seat holder, so the caller passes the seat's confirmed slot times. */
export function slotFor(tsMs: number, slotsMs: number[]): number | null {
  for (const slot of slotsMs) {
    if (tsMs >= slot - PAD.LAUNCH_EARLY_TOLERANCE_MIN * 60_000 && tsMs <= slot + PAD.LAUNCH_LATE_TOLERANCE_MIN * 60_000) return slot;
  }
  return null;
}

/** §4 holder outcome from cost-basis positions: share of holders whose average entry is at or below the settle price. */
export function holderOutcome(positions: { tokens: bigint | number; costUsd: number }[], priceUsd: number, decimals: number): { pct: number; counted: number } {
  const live = positions.filter((p) => Number(p.tokens) > 0 && p.costUsd > 0);
  if (!live.length || !(priceUsd > 0)) return { pct: 0, counted: 0 };
  const ok = live.filter((p) => p.costUsd / (Number(p.tokens) / 10 ** decimals) <= priceUsd * 1.0000001).length;
  return { pct: +((100 * ok) / live.length).toFixed(2), counted: live.length };
}

/** §12 — which phase of the People's Seat election a season day falls in. */
export function electionPhase(day: number): "nominations" | "campaign" | "polls" {
  if (day <= PAD.ELECTION.nominationDays) return "nominations";
  if (day <= PAD.ELECTION.nominationDays + PAD.ELECTION.campaignDays) return "campaign";
  return "polls";
}

export const WEIGHTS = { survival: 0.3, holderOutcome: 0.35, peak: 0.2, conduct: 0.15 } as const;

export type SeatStatus = "seated" | "notice" | "vacant" | "suspended"; // suspended = 30-day suspension after an abandoned launch
export type LaunchStatus = "live" | "open" | "settled" | "banned";
export type ReportState = "due" | "filed" | "late" | "missing";

export interface SeatMetrics {
  /** share of settled launches above launch cap at day 30, 0–100 */
  survivalPct: number;
  /** share of day-30 holders at or above their entry price, 0–100 */
  holderOutcomePct: number;
  /** median peak multiple across settled launches */
  medianPeakX: number;
  /** warnings on record within the scoring window */
  warnings: number;
  /** true if the seat was ever banned (score conduct → 0) */
  banned?: boolean;
  /** settled launches inside the scoring window; a seat with none is provisional (see scoreSeats) */
  launches?: number;
}

export interface SeatRow {
  seat: number;
  developer: string;
  wallet: string;
  since: string;
  metrics: SeatMetrics;
  noticeSeasons: number;
  cleanSeasons: number;
}

export interface ScoredSeat extends SeatRow {
  score: number;
  rank: number;
  status: SeatStatus;
  tenured: boolean;
  provisional: boolean;
}

export const conductScore = (m: SeatMetrics): number => (m.banned ? 0 : Math.max(0, 100 - 25 * m.warnings));
export const peakScore = (medianPeakX: number): number => Math.min(100, Math.round(medianPeakX * 10));

/** §4 — the seat score. Integer 0–100. */
export function seatScore(m: SeatMetrics): number {
  const raw =
    WEIGHTS.survival * m.survivalPct +
    WEIGHTS.holderOutcome * m.holderOutcomePct +
    WEIGHTS.peak * peakScore(m.medianPeakX) +
    WEIGHTS.conduct * conductScore(m);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * §5 — rank all seats, mark the bottom two and anything under the threshold.
 * A seat without a settled launch in the window is provisional: it is ranked and shown, but the bottom-two rule
 * and the threshold only bite once a seat has a record (otherwise a fresh pad would put all twenty on notice).
 */
export function scoreSeats(rows: SeatRow[]): ScoredSeat[] {
  const scored = rows.map((r) => ({ ...r, score: seatScore(r.metrics), provisional: (r.metrics.launches ?? 1) === 0 }));
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.seat - b.seat);
  const withRecord = ranked.filter((s) => !s.provisional);
  const bottom = new Set(withRecord.length >= PAD.SEATS / 2 ? withRecord.slice(-2).map((s) => s.seat) : []); // bottom-two needs half the pad to have a record
  return ranked.map((s, i) => {
    const status: SeatStatus = !s.provisional && (bottom.has(s.seat) || s.score < PAD.THRESHOLD) ? "notice" : "seated";
    const tenured = s.cleanSeasons >= PAD.TENURE_SEASONS;
    return { ...s, rank: i + 1, status, tenured };
  });
}

/** §9 — seat-pool split at season close. Seats on notice forfeit their share to the treasury. */
export function poolShares(seats: ScoredSeat[], poolSol: number): { seat: number; sol: number }[] & { forfeitedSol: number } {
  const eligible = seats.filter((s) => s.status !== "notice");
  const sum = eligible.reduce((a, s) => a + s.score, 0) || 1;
  const out = eligible.map((s) => ({ seat: s.seat, sol: +((poolSol * s.score) / sum).toFixed(6) })) as { seat: number; sol: number }[] & { forfeitedSol: number };
  out.forfeitedSol = 0; // nothing is forfeited because the pool is divided among eligible seats only; the notice seats' would-be share goes to the treasury (§9)
  const total = out.reduce((a, s) => a + s.sol, 0);
  out.forfeitedSol = +(poolSol - total).toFixed(6);
  return out;
}

/** Season arithmetic shared by site, API and oracle. */
export function seasonInfo(nowMs: number, anchorMs: number) {
  const len = PAD.SEASON_DAYS * 86_400_000;
  const idx = Math.floor((nowMs - anchorMs) / len);
  const start = anchorMs + idx * len;
  const end = start + len;
  return {
    season: idx + 1,
    day: Math.min(PAD.SEASON_DAYS, Math.max(1, Math.floor((nowMs - start) / 86_400_000) + 1)),
    start,
    end,
    windowOpens: end - PAD.REPLACEMENT_WINDOW_HOURS * 3_600_000,
    windowOpen: nowMs >= end - PAD.REPLACEMENT_WINDOW_HOURS * 3_600_000,
  };
}

/** §1 — is this UTC timestamp a bookable slot for a seat right now? Any minute is allowed; there are no fixed launch hours. */
export function slotBookable(slotMs: number, nowMs: number, seat: { liveLaunchDay: number | null; hasBooking: boolean }, otherSlotsMs: number[] = []) {
  if (!Number.isFinite(slotMs) || slotMs % 60_000 !== 0) return { ok: false, why: "launch time must be a whole minute" };
  if (slotMs - nowMs < PAD.BOOK_AHEAD_HOURS * 3_600_000) return { ok: false, why: "inside the 48 h booking cutoff" };
  if (seat.liveLaunchDay !== null && seat.liveLaunchDay < PAD.LOCK_DAYS) return { ok: false, why: `seat locked until day ${PAD.LOCK_DAYS}` };
  if (seat.hasBooking) return { ok: false, why: "seat already holds a slot" };
  if (otherSlotsMs.some((o) => Math.abs(o - slotMs) < PAD.MIN_SLOT_GAP_MINUTES * 60_000)) return { ok: false, why: `another launch is announced within ${PAD.MIN_SLOT_GAP_MINUTES / 60} h of that time` };
  return { ok: true as const };
}

export * from "./merkle.js";
export * from "./types.js";
export * from "./net.js";
export * from "./push.js";
export * from "./auth.js";
