/**
 * Ban execution (§7). Malicious conduct — a developer sell inside the vest, undisclosed bundle or linked-wallet
 * sniping, collusion between seats, a mint outside the launch time — is decided by the committee (3 of 5, in public,
 * within 24 h) and ends in a permanent ban: the developer and every linked wallet are blocked from the platform,
 * the seat is vacated the same day and refilled from the bench. A ban pays nothing out: there is no bond, no escrow
 * and no holder payout. The launch is marked banned so the leaderboard and the site show it.
 */
import type { Ctx } from "../ctx.js";
import { emit, tx, pad2 } from "../ctx.js";

export async function executeBan(ctx: Ctx, banId: string): Promise<{ wallets: number } | null> {
  const { rows: [b] } = await ctx.pool.query(`select b.id, b.seat, b.mint, b.reason, b.developer_id, d.handle, d.deployer_wallet, l.ticker from bans b join developers d on d.id = b.developer_id left join launches l on l.mint = b.mint where b.id=$1 and b.executed_at is null`, [banId]);
  if (!b) return null;
  const linked = b.mint ? (await ctx.pool.query(`select address from launch_wallets where mint=$1`, [b.mint])).rows.map((w) => w.address as string) : [];
  const wallets = [...new Set<string>([b.deployer_wallet, ...linked])];
  await tx(ctx.pool, async (q) => {
    for (const w of wallets) await q.query(`insert into banned_wallets(address, ban_id) values ($1,$2) on conflict do nothing`, [w, banId]);
    await q.query(`update bans set executed_at=now() where id=$1`, [banId]);
    if (b.mint) await q.query(`update launches set status='banned', ban_id=$2 where mint=$1`, [b.mint, banId]);
    await q.query(`update seats set status='vacant', developer_id=null, notice_seasons=0, clean_seasons=0, season_flawed=false, suspended_until=null, updated_at=now() where seat=$1 and developer_id=$2`, [b.seat, b.developer_id]);
    await q.query(`update bookings set status='cancelled', cancelled_at=now() where developer_id=$1 and status in ('pending','confirmed') and slot_at > now()`, [b.developer_id]);
    await emit(q, "ban", { seat: b.seat, mint: b.mint ?? undefined, payload: { developer: b.handle, ticker: b.ticker ?? null, reason: b.reason, wallets: wallets.length, rule: "§7 malicious conduct" } });
  });
  ctx.log.info({ seat: pad2(b.seat), wallets: wallets.length }, "ban executed");
  return { wallets: wallets.length };
}

/** Every proposed ban whose decision passed. */
export async function runBans(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.pool.query(`select id from bans where executed_at is null order by proposed_at`);
  let n = 0; for (const r of rows) { try { if (await executeBan(ctx, r.id)) n++; } catch (e) { ctx.log.error({ ban: r.id, err: (e as Error).message }, "ban execution failed"); } }
  return n;
}

/** Banned wallets can never apply, book or register. */
export async function isBanned(q: { query: Ctx["pool"]["query"] }, wallet: string): Promise<boolean> {
  const { rows } = await q.query(`select 1 from banned_wallets where address=$1`, [wallet]);
  return rows.length > 0;
}
