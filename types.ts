/** Wire types shared by the API (/v1) and the public site. Keep in sync with docs/API.md. */

export interface SeatFeedRow {
  seat: number; developer: string; wallet: string; score: number; rank: number;
  status: "seated" | "notice" | "vacant" | "suspended"; tenured: boolean;
  survival_pct: number; holder_outcome_pct: number; median_peak_x: number; warnings: number;
  launches_total: number; launches_season: number; live_launch: string | null; next_slot: string | null;
  pool_share_sol: number; score_30d: number[];
}

export interface SlotFeedRow { time: string; seat: number | null; status: "open" | "closed" | "booked" | "launched" | "passed"; fee_sol: number }

export interface LaunchFeedRow {
  ticker: string; mint: string; seat: number; developer: string; launched_at: string; day: number;
  launch_cap_usd: number; mcap_usd: number; multiple: number; peak_multiple: number; holders: number;
  dev_allocation_pct: number; liquidity: string; status: "live" | "open" | "settled" | "banned";
  reports: { d7: "due" | "filed" | "late" | "missing"; d30: "due" | "filed" | "late" | "missing" };
  disclosed_wallets: { label: string; address: string; pct: number }[];
  banned: { id?: string; day: number; reason: string } | null;
}

export interface PadFeed {
  season: number; day: number; season_ends: string; replacement_window_opens: string; seats: number; on_notice: number[];
  seat_pool_sol: number; treasury_sol: number; slot_fee_sol: number;
  fee_split: { pool: number; treasury: number };
  score_weights: { survival: number; holderOutcome: number; peak: number; conduct: number };
  launches_this_season: number; season_ceiling: number; bench: string[]; treasury_wallet?: string | null; generated_at: string;
}

export type CheckId = "dev_vest_sell" | "first_block_bundle" | "liquidity" | "deployer_cluster";
export type CheckResult = { id: CheckId; result: "pass" | "flag" | "unknown"; detail: string; evidence: string[] };
export interface ScanReport {
  address: string; kind: "wallet" | "mint" | "unknown"; checks: CheckResult[]; flags: number; score: number;
  verdict: string; scanned_at: string; engine: "live" | "preview"; cached?: boolean;
}

export type AlertEvent = "slot_booked" | "launch_live" | "report_due" | "zone_change" | "challenge" | "ban";
export interface AlertRule { id?: string; scope: "all" | "watch" | `seat:${number}`; events: AlertEvent[]; channel: "telegram" | "x" | "webhook"; target?: string; created_at: string }

/** The slice of pg.Pool / pg.PoolClient the packages use. Any object with these methods (incl. a test stub) is accepted. */
export interface QueryResultLike<R = any> { rows: R[]; rowCount: number | null }
export interface Queryable { query<R = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>> }
export interface Db extends Queryable { connect(): Promise<Queryable & { release(): void }>; end(): Promise<void> }
