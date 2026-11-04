-- Cadre · Postgres schema · mirrors docs/SPEC.md
-- Validated against a real Postgres engine in packages/api/test (PGlite). Re-runnable: everything is `if not exists`.
create extension if not exists pgcrypto;

-- ── people ───────────────────────────────────────────────────────────────────
create table if not exists developers (
  id uuid primary key default gen_random_uuid(),
  handle text not null,                      -- public name on the roster
  deployer_wallet text not null unique,
  contact text not null,                     -- never served publicly
  identity_verified_at timestamptz,          -- committee interview done; identity itself is never stored here
  created_at timestamptz not null default now()
);
create index if not exists developers_by_handle on developers (lower(handle));

create table if not exists committee_members (
  name text primary key,
  wallet text not null unique,
  role text not null default 'member',
  since_season smallint not null,
  term_end_season smallint not null,
  focus text,
  removed_at timestamptz                     -- §8 recall
);

-- ── seats ────────────────────────────────────────────────────────────────────
create table if not exists seats (
  seat smallint primary key check (seat between 1 and 20),
  developer_id uuid references developers(id),
  status text not null default 'vacant' check (status in ('seated','notice','vacant','suspended')),
  since_season smallint,
  notice_seasons smallint not null default 0,  -- consecutive closes on notice (§5)
  clean_seasons smallint not null default 0,   -- consecutive seasons without notice, warning or fine (§10)
  season_flawed boolean not null default false, -- a warning or fine this season resets the tenure count at close
  suspended_until timestamptz,                 -- 30-day suspension after an abandoned launch (§7)
  last_launch_at timestamptz,                  -- §1 lock arithmetic
  missed_slots smallint not null default 0,
  seat_pda text,                               -- on-chain Seat PDA once the program is live
  updated_at timestamptz not null default now()
);
insert into seats(seat) select generate_series(1, 20) on conflict do nothing;

-- ── slots and launches ───────────────────────────────────────────────────────
create table if not exists bookings (                       -- §1 slots, §9 fee
  id uuid primary key default gen_random_uuid(),
  slot_at timestamptz not null,
  seat smallint not null references seats(seat),
  developer_id uuid not null references developers(id),
  status text not null default 'pending' check (status in ('pending','confirmed','launched','cancelled','missed','expired')),
  memo text not null unique,                                  -- 'SLOT-XXXXXXXX' on the 3 SOL fee transfer
  fee_lamports bigint not null,
  fee_tx text,
  booked_at timestamptz not null default now(),
  expires_at timestamptz not null,                            -- unpaid bookings free the slot after 2 h
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_notice_hours numeric(8,2),                           -- how far ahead it was cancelled (§7)
  soon_at timestamptz,                                        -- the "launches in 15 min" reminder was sent
  check (extract(second from slot_at) = 0)   -- any whole minute: launch times are chosen by the seat holder
);
create unique index if not exists bookings_one_per_slot on bookings (slot_at) where status in ('pending','confirmed','launched');
create index if not exists bookings_by_seat on bookings (seat, slot_at desc);

create table if not exists launches (
  mint text primary key,
  ticker text not null,
  seat smallint not null references seats(seat),
  developer_id uuid not null references developers(id),
  booking_id uuid references bookings(id),
  launched_at timestamptz not null,                           -- mint creation time on chain
  slot_at timestamptz not null,
  creation_tx text,
  venue text,
  supply numeric(30,0),
  decimals smallint,
  launch_cap_usd numeric(16,2),                               -- first snapshot after launch
  dev_allocation_pct numeric(5,2) not null check (dev_allocation_pct >= 0 and dev_allocation_pct <= 5),
  liquidity text not null,                                    -- 'burned' | 'locked <locker> until <date>' | 'bonding curve'
  precheck jsonb,                                             -- the four checks at registration
  status text not null default 'live' check (status in ('live','open','settled','banned')),
  settled_at timestamptz,
  ban_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists launches_by_seat on launches (seat, launched_at desc);
create index if not exists launches_by_status on launches (status);

create table if not exists launch_wallets (                 -- §6 disclosed insider wallets
  mint text not null references launches(mint) on delete cascade,
  label text not null,
  address text not null,
  pct numeric(5,2) not null,
  primary key (mint, address)
);

create table if not exists launch_snapshots (               -- 6-hour market snapshots for charts + scoring
  mint text not null references launches(mint) on delete cascade,
  at timestamptz not null,
  mcap_usd numeric(18,2) not null,
  holders int not null,
  price_usd numeric(24,12),
  liquidity_usd numeric(18,2),
  primary key (mint, at)
);
create index if not exists snapshots_by_mint on launch_snapshots (mint, at desc);

create table if not exists holder_positions (               -- per-holder cost basis, built from snapshot deltas at the snapshot price
  mint text not null references launches(mint) on delete cascade,
  owner text not null,
  tokens numeric(30,0) not null,                              -- raw units
  cost_usd numeric(18,6) not null default 0,                  -- sum(buys × price at the snapshot that first showed them)
  first_seen timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (mint, owner)
);

create table if not exists launch_holder_outcomes (         -- day-30 holder outcome per launch (§4)
  mint text primary key references launches(mint),
  holders_at_or_above_entry_pct numeric(5,2) not null,
  holders_counted int not null,
  price_usd numeric(24,12),
  computed_at timestamptz not null default now()
);

create table if not exists reports (                        -- §6 day-7 / day-30
  mint text not null references launches(mint) on delete cascade,
  which smallint not null check (which in (7,30)),
  due_at timestamptz not null,
  filed_at timestamptz,
  url text,
  reminded_at timestamptz,                                    -- report_due event sent
  warned_at timestamptz,                                      -- warning decision recorded (§7)
  primary key (mint, which)
);
-- a generated column cannot call now(), so the state is a stable function used by the feeds
create or replace function report_state(filed timestamptz, due timestamptz) returns text language sql stable as $$
  select case when filed is null then (case when now() > due + interval '24 hours' then 'missing' else 'due' end)
              when filed > due + interval '24 hours' then 'late' else 'filed' end
$$;

-- ── scoring ──────────────────────────────────────────────────────────────────
create table if not exists scores (                         -- §4 daily oracle writes
  seat smallint not null references seats(seat),
  day date not null,
  survival_pct numeric(5,2) not null,
  holder_outcome_pct numeric(5,2) not null,
  median_peak_x numeric(8,2) not null,
  warnings smallint not null,
  score smallint not null,
  rank smallint not null,
  inputs jsonb not null,                                      -- every launch and number that went into it
  inputs_hash text,                                           -- sha256 of inputs, what goes on chain
  oracle_sig text,                                            -- signature of write_score on chain
  primary key (seat, day)
);
create index if not exists scores_by_day on scores (day desc);

-- ── governance ───────────────────────────────────────────────────────────────
create table if not exists decisions (                      -- public record; 3 of 5 committee votes execute it
  id uuid primary key default gen_random_uuid(),
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  type text not null check (type in ('Bench','Rejected','Seat','Season','Warning','Fine','Suspend','Ban','Challenge','Recall','Bounty','Election')),
  subject text not null,
  outcome text not null,
  payload jsonb not null default '{}',                        -- structured effect: seat, mint, fine_sol, application_id, challenge_id, flag_id, reason
  status text not null default 'proposed' check (status in ('proposed','executed','rejected','expired','auto')),
  proposed_by text,                                           -- committee wallet, or 'oracle' for automatic penalties (§7)
  votes_for smallint not null default 0,
  votes_against smallint not null default 0,
  evidence jsonb,
  tx text
);
create index if not exists decisions_open on decisions (proposed_at) where status = 'proposed';
create table if not exists decision_votes (
  decision_id uuid not null references decisions(id) on delete cascade,
  wallet text not null,
  vote text not null check (vote in ('for','against')),
  voted_at timestamptz not null default now(),
  primary key (decision_id, wallet)
);

create table if not exists bans (                          -- §7 malicious conduct = permanent ban, no payout
  id uuid primary key default gen_random_uuid(),
  seat smallint not null,
  developer_id uuid references developers(id),
  mint text references launches(mint),                        -- the launch the breach happened on, if any
  decision_id uuid references decisions(id),
  proposed_at timestamptz not null default now(),
  executed_at timestamptz,
  reason text not null,
  reason_hash text not null,
  tx text
);
create table if not exists banned_wallets (                  -- the developer's wallet and every linked wallet; can never apply, book or register again
  address text primary key,
  ban_id uuid not null references bans(id),
  at timestamptz not null default now()
);

create table if not exists challenges (                     -- §5
  id uuid primary key default gen_random_uuid(),
  seat smallint not null references seats(seat),
  challenger_id uuid not null references developers(id),
  kind text not null check (kind in ('signal','filed')),
  status text not null default 'open' check (status in ('open','filed','decided','withdrawn','expired')),
  evidence text,                                              -- public evidence is required for a filed challenge
  filed_at timestamptz not null default now(),
  decided_at timestamptz,
  outcome text check (outcome in ('replaced','kept','withdrawn')),
  decision_id uuid references decisions(id)
);
create index if not exists challenges_by_seat on challenges (seat, filed_at desc);

create table if not exists holder_votes (                   -- §5 holder signal
  challenge_id uuid not null references challenges(id) on delete cascade,
  wallet text not null,
  vote text not null check (vote in ('keep','replace')),
  weight_pct numeric(8,4) not null,                           -- position at snapshot
  mint text not null,
  voted_at timestamptz not null default now(),
  primary key (challenge_id, wallet)
);

create table if not exists applications (                   -- §2 + §11
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  handle text not null,
  deployer_wallet text not null,
  contact text not null,                                      -- never served publicly
  mints text[] not null,
  worst_launch text,
  precheck jsonb,
  stage text not null default 'onchain' check (stage in ('onchain','interview','public_review','bench','rejected','seated')),
  public_review_ends timestamptz,
  bench_rank int,
  developer_id uuid references developers(id),                -- created when the applicant reaches the bench
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists applications_one_open_per_wallet on applications (deployer_wallet) where stage in ('onchain','interview','public_review','bench');

create table if not exists review_flags (                   -- §11 bounty flags
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  filer_wallet text not null,
  evidence text[] not null,
  claim text not null,
  filed_at timestamptz not null default now(),
  upheld boolean,
  decision_id uuid references decisions(id),
  bounty_paid_tx text
);
create table if not exists locked_wallets (                 -- §11: three discarded flags lock the filing wallet
  wallet text primary key,
  locked_at timestamptz not null default now(),
  reason text not null
);

-- ── money ────────────────────────────────────────────────────────────────────
create table if not exists ledger (                         -- treasury and seat-pool movements
  id bigserial primary key,
  at timestamptz not null default now(),
  account text not null check (account in ('treasury','seat_pool')),
  entry text not null,
  lamports bigint not null,                                   -- signed
  counterparty text,
  tx text
);
create index if not exists ledger_by_account on ledger (account, at desc);

-- ── scanner ────────────────────────────────────────────────────
create table if not exists scans (                          -- scanner cache (free for everyone)
  address text not null,
  scanned_at timestamptz not null default now(),
  report jsonb not null,
  primary key (address, scanned_at)
);


create table if not exists events (                         -- everything the pad emits; the log and the alert bot read this
  id bigserial primary key,
  at timestamptz not null default now(),
  type text not null,                                         -- slot_booked, launch_live, report_due, zone_change, challenge, ban, decision, ledger, ballot, …
  seat smallint,
  mint text,
  payload jsonb not null,
  delivered_at timestamptz
);
create index if not exists events_undelivered on events (id) where delivered_at is null;
create index if not exists events_by_type on events (type, id desc);

create table if not exists nonces (                         -- replay protection for every signed request (ballots, bookings, reports, votes…)
  nonce text primary key,
  wallet text not null,
  purpose text not null,
  used_at timestamptz not null default now()
);
create index if not exists nonces_by_age on nonces (used_at);

-- ── v2: deployer index (scanner moat), billing ──────────────────────────────
create table if not exists deployer_index (
  mint text primary key,
  deployer text not null,
  created_at timestamptz not null,
  signature text not null,
  venue text not null,
  funding_parent text,
  funding_signature text,
  parent_attempts smallint not null default 0,
  parent_resolved_at timestamptz
);
create index if not exists deployer_index_by_deployer on deployer_index (deployer, created_at desc);

create table if not exists waitlist (
  contact text primary key,                 -- handle or email, lowercased
  source text not null default 'site',
  ip_hash text,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

create table if not exists poll_votes (
  poll_id text not null,
  voter text not null,                      -- 'w:<wallet>' or 'ip:<hash>'
  option text not null,
  voted_at timestamptz not null default now(),
  primary key (poll_id, voter)
);

-- ── v3: the people's seat (§12) ──────────────────────────────────────────────
create table if not exists elections (
  season smallint primary key,
  snapshot_slot bigint,                     -- Solana slot of the day-20 snapshot
  snapshot_at timestamptz,
  polls_open timestamptz not null,
  polls_close timestamptz not null,
  result text,                              -- winning developer handle, written at the cut
  result_developer_id uuid references developers(id),
  tally_root text,                          -- Merkle root of the ballots, written on chain with the result
  result_tx text
);
create table if not exists election_candidates (
  season smallint not null references elections(season),
  developer_id uuid not null references developers(id),
  statement text,
  declared_at timestamptz not null default now(),
  confirmed_at timestamptz,                 -- committee confirms eligibility only; never the winner
  primary key (season, developer_id)
);
create table if not exists election_snapshot (            -- §12 day-20 holder positions, written by the oracle; the only source of ballot weight
  season smallint not null references elections(season),
  wallet text not null,
  weight_pct numeric(8,4) not null,         -- share of eligible supply, before the 0.5 % cap
  primary key (season, wallet)
);
create table if not exists election_ballots (
  season smallint not null references elections(season),
  wallet text not null,
  developer_id uuid not null references developers(id),
  weight_pct numeric(8,4) not null,         -- position at the snapshot, capped at 0.5% of supply
  cast_at timestamptz not null default now(),
  moved_from uuid,
  primary key (season, wallet)
);
create index if not exists election_ballots_by_candidate on election_ballots (season, developer_id);

-- ── ops ──────────────────────────────────────────────────────────────────────
create table if not exists push_subscriptions (            -- Web Push (VAPID): one row per browser, scoped to seats and event types
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  seats smallint[] not null default '{}',                   -- empty = every seat
  events text[] not null default '{}',                      -- empty = the default set (shared/push.ts)
  wallet text,                                              -- optional, so a seat holder's own browser can be told apart in /v1/wallets
  ua text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures int not null default 0,
  disabled_at timestamptz
);
create table if not exists job_runs (                       -- every scheduled job writes a row; /v1/status reads the latest
  id bigserial primary key,
  name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  detail jsonb
);
create index if not exists job_runs_by_name on job_runs (name, started_at desc);

-- ── status page ──────────────────────────────────────────────────────────────
create table if not exists health_state (                   -- the latest probe per component (what /v1/health shows)
  component text primary key,
  state text not null check (state in ('operational','degraded','down','off')),
  latency_ms int,
  detail text,
  since timestamptz not null default now(),                   -- when the state last changed
  bad_streak int not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists health_daily (                   -- per-day uptime bars: probes that were not 'down'
  day date not null,
  component text not null,
  ok int not null default 0,
  degraded int not null default 0,
  total int not null default 0,
  primary key (day, component)
);
create table if not exists incidents (
  id bigserial primary key,
  component text not null,
  title text not null,
  started_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists incidents_by_start on incidents (started_at desc);

-- Telegram bot: self-service subscriptions per chat (no key needed) and small bot state (digest bookkeeping)
create table if not exists tg_subs (
  chat_id text primary key,
  seats smallint[] not null default '{}',                     -- empty = all seats
  events text[] not null default '{slot_soon,launch_live,ban,zone_change,decision,season_close,election_result}',
  muted boolean not null default false,
  digest boolean not null default false,                      -- daily leaderboard digest, 08:00 UTC
  failures int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists bot_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
