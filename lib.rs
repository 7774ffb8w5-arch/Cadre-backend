//! Cadre — seat registry program (reference skeleton, Anchor 0.30).
//!
//! There is no bond, no escrow, no holder payout and no pool in this program: it holds no money at all.
//! It is the public, tamper-evident record of who sits in the 20 seats and what the rules did to them.
//!
//! State machine (docs/SPEC.md §3, §5, §7):
//!   Vacant → assign_seat (oracle, after the committee's vetting decision) → Active
//!   Active → write_score (oracle, daily; inputs hash lets anyone recompute the leaderboard)
//!   Active → propose_ban → approve_ban ×3 of 5 within 24 h → execute_ban (oracle) → Vacant + BanRecord for the
//!            developer's wallet (permanent). Linked wallets are blocked by the API from the same decision.
//!   Active → mark_replaced (oracle; season close / challenge) → Vacant
//!   People's Seat: write_election_result (oracle); recall: sign_recall (11 of 20 seat holders).
//! Nothing here can be moved by an operator key, because nothing here holds value beyond account rent.
//!
//! Not audited. Not deployed.

use anchor_lang::prelude::*;

declare_id!("TwEnTy1111111111111111111111111111111111111"); // placeholder until `anchor keys sync`

pub const SEATS: u8 = 20;
pub const THRESHOLD: u8 = 3; // of 5
pub const BAN_WINDOW: i64 = 24 * 3600;
pub const RECALL_THRESHOLD: usize = 11; // of 20 seats

#[program]
pub mod twenty {
    use super::*;

    /// One-time init, callable only by the program's upgrade authority. After this the pad has no authority: only the committee, the oracle and timers act.
    pub fn initialize(ctx: Context<Initialize>, committee: [Pubkey; 5], oracle: Pubkey) -> Result<()> {
        let pad = &mut ctx.accounts.pad;
        pad.committee = committee;
        pad.oracle = oracle;
        pad.bump = ctx.bumps.pad;
        Ok(())
    }

    /// §2/§3 — a vetted developer takes a vacant seat. The oracle signs after the committee's decision; a banned wallet can never be assigned.
    pub fn assign_seat(ctx: Context<AssignSeat>, seat_index: u8, holder: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        require!(seat_index >= 1 && seat_index <= SEATS, TwentyError::BadSeat);
        require!(ctx.accounts.ban_record.data_is_empty(), TwentyError::Banned);
        let seat = &mut ctx.accounts.seat;
        require!(seat.status == SeatStatus::Vacant, TwentyError::SeatTaken);
        seat.index = seat_index;
        seat.holder = holder;
        seat.score = 0;
        seat.status = SeatStatus::Active;
        seat.assigned_at = Clock::get()?.unix_timestamp;
        seat.inputs_hash = [0u8; 32];
        emit!(SeatEvent { seat: seat_index, kind: "assigned".into() });
        Ok(())
    }

    /// §4 — the score oracle publishes the daily score. Inputs hash is the sha256 of the JSON the API serves under /v1/seats/:seat/inputs, so anyone can recompute the ranking.
    pub fn write_score(ctx: Context<Oracle>, score: u8, inputs_hash: [u8; 32]) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        require!(score <= 100, TwentyError::BadScore);
        let seat = &mut ctx.accounts.seat;
        require!(seat.status == SeatStatus::Active || seat.status == SeatStatus::Suspended, TwentyError::SeatNotActive);
        seat.score = score;
        seat.inputs_hash = inputs_hash;
        emit!(SeatEvent { seat: seat.index, kind: "score".into() });
        Ok(())
    }

    /// §7 — abandoned launch: 30-day suspension (the oracle sets and lifts it; the date lives in the decision record).
    pub fn set_suspended(ctx: Context<Oracle>, suspended: bool) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        let seat = &mut ctx.accounts.seat;
        require!(seat.status == SeatStatus::Active || seat.status == SeatStatus::Suspended, TwentyError::SeatNotActive);
        seat.status = if suspended { SeatStatus::Suspended } else { SeatStatus::Active };
        emit!(SeatEvent { seat: seat.index, kind: if suspended { "suspended" } else { "restored" }.into() });
        Ok(())
    }

    /// §5 — season close or an upheld challenge: the seat is vacated and refilled from the bench.
    pub fn mark_replaced(ctx: Context<Oracle>) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        let seat = &mut ctx.accounts.seat;
        require!(seat.status != SeatStatus::Vacant, TwentyError::SeatNotActive);
        let index = seat.index;
        seat.reset_vacant();
        emit!(SeatEvent { seat: index, kind: "replaced".into() });
        Ok(())
    }

    /// §7 — a committee member opens a ban proposal. Public immediately, expires in 24 h.
    pub fn propose_ban(ctx: Context<ProposeBan>, launch_mint: Pubkey, reason_hash: [u8; 32]) -> Result<()> {
        require!(ctx.accounts.pad.committee.contains(&ctx.accounts.member.key()), TwentyError::NotCommittee);
        require!(ctx.accounts.seat.status == SeatStatus::Active || ctx.accounts.seat.status == SeatStatus::Suspended, TwentyError::SeatNotActive);
        let p = &mut ctx.accounts.proposal;
        let now = Clock::get()?.unix_timestamp;
        p.seat = ctx.accounts.seat.index;
        p.holder = ctx.accounts.seat.holder;
        p.launch_mint = launch_mint;
        p.reason_hash = reason_hash;
        p.signers = [Pubkey::default(); 5];
        p.signers[0] = ctx.accounts.member.key();
        p.created_at = now;
        p.expires_at = now.checked_add(BAN_WINDOW).ok_or(TwentyError::Overflow)?;
        p.executed = false;
        Ok(())
    }

    pub fn approve_ban(ctx: Context<ApproveBan>) -> Result<()> {
        let member = ctx.accounts.member.key();
        require!(ctx.accounts.pad.committee.contains(&member), TwentyError::NotCommittee);
        let p = &mut ctx.accounts.proposal;
        require!(!p.executed, TwentyError::AlreadyExecuted);
        require!(Clock::get()?.unix_timestamp <= p.expires_at, TwentyError::ProposalExpired);
        require!(!p.signers.contains(&member), TwentyError::AlreadySigned);
        let slot = p.signers.iter().position(|s| *s == Pubkey::default()).ok_or(TwentyError::AlreadySigned)?;
        p.signers[slot] = member;
        Ok(())
    }

    /// §7 — with 3 of 5 committee signatures inside the 24 h window, the oracle executes the ban: the developer's wallet gets a permanent BanRecord and the seat is vacated the same day. Nothing is paid out.
    pub fn execute_ban(ctx: Context<ExecuteBan>) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.proposal;
        require!(!p.executed, TwentyError::AlreadyExecuted);
        require!(now <= p.expires_at, TwentyError::ProposalExpired);
        require!(p.signers.iter().filter(|s| **s != Pubkey::default()).count() >= THRESHOLD as usize, TwentyError::NotEnoughSignatures);
        require!(ctx.accounts.seat.index == p.seat && ctx.accounts.seat.holder == p.holder, TwentyError::ProposalSeatMismatch);
        p.executed = true;
        let rec = &mut ctx.accounts.ban_record;
        rec.wallet = p.holder;
        rec.reason_hash = p.reason_hash;
        rec.launch_mint = p.launch_mint;
        rec.banned_at = now;
        let seat = &mut ctx.accounts.seat;
        let index = seat.index;
        seat.reset_vacant();
        emit!(SeatEvent { seat: index, kind: "banned".into() });
        Ok(())
    }

    /// Anyone may close an expired, unexecuted proposal; the rent goes back to the member who opened it.
    pub fn expire_proposal(ctx: Context<Expire>) -> Result<()> {
        let p = &ctx.accounts.proposal;
        require!(!p.executed && Clock::get()?.unix_timestamp > p.expires_at, TwentyError::ProposalNotExpired);
        Ok(())
    }

    /// §8 — 11 of 20 seat holders remove a committee member. Signatures are collected on the Recall PDA.
    pub fn sign_recall(ctx: Context<Recall>, member: Pubkey) -> Result<()> {
        let seat = &ctx.accounts.seat;
        require_keys_eq!(seat.holder, ctx.accounts.holder.key(), TwentyError::NotHolder);
        require!(seat.status == SeatStatus::Active, TwentyError::SeatNotActive);
        let r = &mut ctx.accounts.recall;
        require!(!r.seats.contains(&seat.index), TwentyError::AlreadySigned);
        let slot = r.seats.iter().position(|s| *s == 0).ok_or(TwentyError::AlreadySigned)?;
        r.seats[slot] = seat.index;
        r.member = member;
        if r.seats.iter().filter(|s| **s != 0).count() >= RECALL_THRESHOLD {
            let pad = &mut ctx.accounts.pad;
            if let Some(i) = pad.committee.iter().position(|m| *m == member) { pad.committee[i] = Pubkey::default(); }
            emit!(SeatEvent { seat: 0, kind: "recall".into() });
        }
        Ok(())
    }

    /// §12 — the oracle writes the People's Seat result once per season: winner, the Merkle root of the ballots and the turnout, so anyone can recompute the count from the published ballot file.
    pub fn write_election_result(ctx: Context<ElectionResultCtx>, season: u16, winner: Pubkey, tally_root: [u8; 32], ballots: u32, turnout_bps: u16) -> Result<()> {
        require_keys_eq!(ctx.accounts.pad.oracle, ctx.accounts.oracle.key(), TwentyError::NotOracle);
        require!(season >= 1 && turnout_bps <= 10_000 && tally_root != [0u8; 32] && winner != Pubkey::default(), TwentyError::BadElection);
        let r = &mut ctx.accounts.result;
        r.season = season;
        r.winner = winner;
        r.tally_root = tally_root;
        r.ballots = ballots;
        r.turnout_bps = turnout_bps;
        r.written_at = Clock::get()?.unix_timestamp;
        emit!(SeatEvent { seat: SEATS, kind: "election".into() });
        Ok(())
    }
}

/* ── accounts ────────────────────────────────────────────────────────────────── */

#[account]
pub struct Pad { pub committee: [Pubkey; 5], pub oracle: Pubkey, pub bump: u8 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SeatStatus { Vacant, Active, Suspended }

#[account]
pub struct Seat { pub index: u8, pub holder: Pubkey, pub score: u8, pub status: SeatStatus, pub assigned_at: i64, pub inputs_hash: [u8; 32] }
impl Seat {
    pub const SPACE: usize = 8 + 1 + 32 + 1 + 1 + 8 + 32;
    /// A vacated seat keeps only its index; the next developer starts with a clean record.
    pub fn reset_vacant(&mut self) {
        self.holder = Pubkey::default(); self.score = 0; self.status = SeatStatus::Vacant; self.assigned_at = 0; self.inputs_hash = [0u8; 32];
    }
}

#[account]
pub struct BanProposal { pub seat: u8, pub holder: Pubkey, pub launch_mint: Pubkey, pub reason_hash: [u8; 32], pub signers: [Pubkey; 5], pub created_at: i64, pub expires_at: i64, pub executed: bool }
impl BanProposal { pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 32 * 5 + 8 + 8 + 1; }

/// Permanent. Its existence is the ban: `assign_seat` refuses a wallet that has one.
#[account]
pub struct BanRecord { pub wallet: Pubkey, pub reason_hash: [u8; 32], pub launch_mint: Pubkey, pub banned_at: i64 }
impl BanRecord { pub const SPACE: usize = 8 + 32 + 32 + 32 + 8; }

#[account]
pub struct ElectionResult { pub season: u16, pub winner: Pubkey, pub tally_root: [u8; 32], pub ballots: u32, pub turnout_bps: u16, pub written_at: i64 }
impl ElectionResult { pub const SPACE: usize = 8 + 2 + 32 + 32 + 4 + 2 + 8; }

#[account]
pub struct RecallVote { pub member: Pubkey, pub seats: [u8; 20] }

#[event]
pub struct SeatEvent { pub seat: u8, pub kind: String }

/* ── contexts (seeds give every object a deterministic address) ──────────────── */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + 32 * 5 + 32 + 1, seeds = [b"pad"], bump)] pub pad: Account<'info, Pad>,
    #[account(mut)] pub payer: Signer<'info>, pub system_program: Program<'info, System>,
    /// Only the program's upgrade authority can initialise it, so nobody can front-run the deployer and pick the committee.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ TwentyError::NotUpgradeAuthority)] pub program: Program<'info, crate::program::Twenty>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ TwentyError::NotUpgradeAuthority)] pub program_data: Account<'info, ProgramData>,
}
#[derive(Accounts)]
#[instruction(seat_index: u8, holder: Pubkey)]
pub struct AssignSeat<'info> {
    #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>,
    #[account(init_if_needed, payer = oracle, space = Seat::SPACE, seeds = [b"seat".as_ref(), &[seat_index]], bump)] pub seat: Account<'info, Seat>,
    /// CHECK: the BanRecord PDA of `holder`; it must not exist
    #[account(seeds = [b"ban".as_ref(), holder.as_ref()], bump)] pub ban_record: UncheckedAccount<'info>,
    #[account(mut)] pub oracle: Signer<'info>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Oracle<'info> { #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>, #[account(mut, seeds = [b"seat".as_ref(), &[seat.index]], bump)] pub seat: Account<'info, Seat>, pub oracle: Signer<'info> }
#[derive(Accounts)]
pub struct ProposeBan<'info> {
    #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>,
    #[account(seeds = [b"seat".as_ref(), &[seat.index]], bump)] pub seat: Account<'info, Seat>,
    #[account(init, payer = member, space = BanProposal::SPACE, seeds = [b"ban-proposal".as_ref(), seat.key().as_ref(), &seat.assigned_at.to_le_bytes()], bump)] pub proposal: Account<'info, BanProposal>,
    #[account(mut)] pub member: Signer<'info>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ApproveBan<'info> { #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>, #[account(mut)] pub proposal: Account<'info, BanProposal>, pub member: Signer<'info> }
#[derive(Accounts)]
pub struct ExecuteBan<'info> {
    #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>,
    #[account(mut, seeds = [b"seat".as_ref(), &[seat.index]], bump)] pub seat: Account<'info, Seat>,
    #[account(mut)] pub proposal: Account<'info, BanProposal>,
    #[account(init, payer = oracle, space = BanRecord::SPACE, seeds = [b"ban".as_ref(), proposal.holder.as_ref()], bump)] pub ban_record: Account<'info, BanRecord>,
    #[account(mut)] pub oracle: Signer<'info>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut, close = rent_to, constraint = rent_to.key() == proposal.signers[0] @ TwentyError::NotProposer)] pub proposal: Account<'info, BanProposal>,
    /// CHECK: receives the rent; constrained above to the member who opened the proposal and paid for it
    #[account(mut)] pub rent_to: UncheckedAccount<'info>,
}
#[derive(Accounts)]
#[instruction(season: u16)]
pub struct ElectionResultCtx<'info> {
    #[account(seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>,
    #[account(init, payer = oracle, space = ElectionResult::SPACE, seeds = [b"election".as_ref(), &season.to_le_bytes()], bump)] pub result: Account<'info, ElectionResult>,
    #[account(mut)] pub oracle: Signer<'info>, pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(member: Pubkey)]
pub struct Recall<'info> {
    #[account(mut, seeds = [b"pad"], bump = pad.bump)] pub pad: Account<'info, Pad>,
    #[account(seeds = [b"seat".as_ref(), &[seat.index]], bump)] pub seat: Account<'info, Seat>,
    #[account(init_if_needed, payer = holder, space = 8 + 32 + 20, seeds = [b"recall".as_ref(), member.as_ref()], bump)] pub recall: Account<'info, RecallVote>,
    #[account(mut)] pub holder: Signer<'info>, pub system_program: Program<'info, System>,
}

#[error_code]
pub enum TwentyError {
    #[msg("seat index must be 1–20")] BadSeat,
    #[msg("seat is taken")] SeatTaken,
    #[msg("signer is not the seat holder")] NotHolder,
    #[msg("signer is not the score oracle")] NotOracle,
    #[msg("only the program upgrade authority can initialise the pad")] NotUpgradeAuthority,
    #[msg("signer is not a committee member")] NotCommittee,
    #[msg("seat is not active")] SeatNotActive,
    #[msg("proposal expired")] ProposalExpired,
    #[msg("proposal has not expired")] ProposalNotExpired,
    #[msg("already signed")] AlreadySigned,
    #[msg("fewer than 3 of 5 signatures")] NotEnoughSignatures,
    #[msg("already executed")] AlreadyExecuted,
    #[msg("arithmetic overflow")] Overflow,
    #[msg("score must be 0–100")] BadScore,
    #[msg("proposal was opened against another seat")] ProposalSeatMismatch,
    #[msg("rent goes back to the proposer")] NotProposer,
    #[msg("invalid election result")] BadElection,
    #[msg("this wallet is banned from the platform")] Banned,
}
