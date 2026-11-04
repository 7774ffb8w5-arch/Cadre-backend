# Devnet rehearsal

Run the whole pad — program, API, scheduler, bot, site — on Solana devnet with throwaway keys before any real
money is involved. Amounts are divided by 100 (`AMOUNT_SCALE=100`: slot fee 0.03 SOL, missed-slot fine 0.05 SOL), so faucet SOL is enough. The scale only exists on devnet: `amountScale()` returns 1 whenever
`SOLANA_CLUSTER` is not `devnet`, and the pre-flight fails a mainnet run that still carries `AMOUNT_SCALE`.

## 1 · Keys and funding

```
solana-keygen new -o keys/deployer.json      # pays for the program deploy (≈ 4 SOL)
solana-keygen new -o keys/treasury.json      # receives slot fees
solana-keygen new -o keys/oracle.json        # signs scores and results (≈ 1 SOL for fees)
solana-keygen new -o keys/committee-1.json   # … five committee wallets
solana config set --url devnet && solana airdrop 2 $(solana-keygen pubkey keys/deployer.json)   # repeat, or use faucet.solana.com
```

## 2 · Program

```
cd program
anchor keys sync                              # writes the program id into lib.rs and Anchor.toml
anchor build                                  # the program holds no money, so devnet and mainnet are the same build
anchor deploy --provider.cluster devnet --provider.wallet ../keys/deployer.json
```
Then initialise the pad immediately — one call creates the pad, and it can only ever run once:
```
npm run program:init -- --payer keys/deployer.json \
  --committee keys/committee-1.json,keys/committee-2.json,keys/committee-3.json,keys/committee-4.json,keys/committee-5.json \
  --oracle keys/oracle.json            # dry run: prints the plan
… same command with --send             # submits, then reads the pad back and compares it with what you asked for
```
Entries may be wallet addresses or keypair files. The tool refuses mainnet without `--i-know-this-is-mainnet`, and on a
pad that is already initialised it only compares (exit 0 if the keys match, 1 if not). `initialize` can only be called by the program's **upgrade authority**: the program checks that the payer is the
authority recorded in the program's ProgramData account, so nobody can front-run the deployer and choose the committee.
Use the deployer keypair as `--payer`; the tool reads the authority first and stops with a clear message if the payer
is not it (or the program is already immutable). Never build mainnet with
`--features devnet`.

## 3 · Environment and pre-flight

```
cp .env.devnet.example .env.devnet            # fill in the keys, secrets, database, RPC
npm run devnet:check -- --env .env.devnet
```
The check reads the cluster, proves the RPC is really devnet (genesis hash), that the program is deployed and
executable, that `PROGRAM_ID` matches `Anchor.toml`, that the oracle keypair loads and has fees, and that the
secrets, database, VAPID and Telegram settings are present. It exits 1 on any failure — do not start with a red line.

## 4 · Run it

```
createdb twenty_devnet && npm run db:migrate           # DATABASE_URL from .env.devnet
npm run build
docker compose --env-file .env.devnet -f infra/docker-compose.yml up -d     # api, jobs, bot, db
```
Helius: create a **devnet** webhook for the treasury and the seat wallets, `Authorization: <HELIUS_WEBHOOK_SECRET>`,
URL `https://api-dev…/v1/webhooks/helius`.

## 5 · The site

```
API_ORIGIN=https://api-dev.cadre-us.org node web/build.mjs   # adds the dev API to connect-src and re-stamps the CSP hashes
cp web/config.devnet.js web/config.js                         # set TREASURY to the treasury address (the page pins payments to it)
```
Serve it over https on the dev host. Switch Phantom / Solflare to **Devnet** (Settings → Developer settings).

## 6 · Rehearsal checklist

| # | Do | Expect |
|---|----|--------|
| 1 | Connect a seat-holder wallet | role "Seat NN", lands in the console |
| 2 | Book a slot, pay with one tap | Pay → Sent → Confirmed within ~1 min; console shows the booking |
| 3 | Reject the wallet prompt | "Cancelled — nothing was sent", button usable again |
| 4 | Pay a booking from a phone wallet via the QR | confirms the same way |
| 5 | Open `#room-NN` 15 min before: push arrives, room locked | CA hidden until the token exists |
| 6 | Create a token with the seat wallet inside the slot | room shows the real CA within a minute |
| 7 | File day-7 / day-30 reports (accelerated clock), complete the disclosure | records on the log |
| 8 | Challenge a seat with public evidence (free) | challenge filed, committee votes, decision on the record |
| 9 | Run a ban with the committee | developer and linked wallets blocked, seat vacated and refilled from the bench, nothing paid out |
| 10 | Run a season close and the People's Seat vote | scores written on chain, ballot counted |
| 11 | `GET /v1/status` after each step | every job `ok` |

**Known devnet limits.** pump.fun does not exist on devnet, so launches are plain SPL mints; check that the
Helius devnet webhook delivers the creation to `deployer_index`, and if not, register the launch with
`POST /v1/launches` (the documented fallback in `docs/OPERATIONS.md`). Prices and holders come from devnet tokens
with no market, so score inputs are synthetic — rehearse the mechanics, not the numbers.

## 7 · Before mainnet

External audit of the program · a full `anchor test` suite on a local validator · one complete accelerated season on
devnet with every row above ticked · the committee rehearsed on real signatures · mainnet keys in a hardware
wallet or multisig · `AMOUNT_SCALE` removed and the program rebuilt ·
`npm run devnet:check -- --env .env.mainnet --cluster mainnet-beta` clean.
