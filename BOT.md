# Telegram bot

Service `bot` (`node packages/bot/dist/index.js`). Needs `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERTS_CHANNEL` (public channel, bot is admin), `PUBLIC_SITE_URL`.

**Setup:** @BotFather → `/newbot` → token. Create the channel, add the bot as admin with "post messages". The bot registers its command menu itself on start.

**Commands**
| Command | What it does |
|---|---|
| `/leaderboard` | top 10 of the latest oracle day, ⚠️ for the replacement zone |
| `/seat 7` | score, rank, survival, holder outcome, next launch, last launch |
| `/next` · `/live` · `/bans` · `/status` | upcoming launches, launches in the 30-day window, latest bans, system status |
| `/watch 7` · `/unwatch 7` · `/watching` | per-seat alerts (reminder, live, reports, zone changes); bans and decisions are always pad-wide |
| `/alerts` | inline toggles per event type · `/digest` daily leaderboard at 08:00 UTC · `/mute` `/unmute` `/stop` |

**Delivery:** the channel gets the major events; every chat in `tg_subs` gets what it enabled. There are no paid tiers, keys or webhooks. A chat that blocks the bot is removed; 5 consecutive failures pause it. Sends are paced (40 ms), commands are limited to 1/s per chat. The daily digest is sent once per UTC day (`bot_state.digest_day`), never before 08:00 UTC and only when scores exist.
