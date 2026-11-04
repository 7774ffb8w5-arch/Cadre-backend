# Company setup — what turns the pad into a business that can take money

Not legal advice. This is the checklist a founder works through with a lawyer before the first payment
arrives. The points are ordered by how much they block revenue.

## 1. What the business actually sells (and what it must not)
- **Sells**: licences (franchise) and a launch fee for using
  the pad's calendar. All are services. None is an investment product.
- **Does not sell**: seats, tokens, or any claim on launches. The pad never holds holders' or developers' money: there is no bond or escrow at all. The only money the
  operator sees is launch fees.
- Why this matters: a launchpad that *custodies* funds or *sells* access rights looks like a crypto-asset
  service provider; a launchpad that sells data and calendar slots looks like SaaS. Keep the program
  non-custodial and the language on the site consistent with that.

## 2. Entity and jurisdiction
- Founder is in Germany. Options a crypto counsel will put on the table:
  - **German GmbH (or UG)** for the SaaS revenue (scanner, feeds, licences). Clean for invoicing, taxes, hiring.
  - A separate **non-profit or foundation-style entity** (Swiss Verein, Cayman Foundation Company) to hold the
    rulebook, the program upgrade authority (if any) and the committee framework, so the rules are not an
    asset of the operating company.
- Decide early who signs as the **score oracle** and who controls **program upgrades**. The site promises
  "no admin key": make that true (immutable program or multisig with public members).

## 3. MiCA (EU) — the question that decides the structure
- MiCA applies to crypto-asset service providers (CASPs) and to issuers. The pad issues nothing.
- Risk areas to review with counsel: whether running the slot calendar + seat-registry program constitutes
  "operating a trading platform" or "custody" (it should not, if the program is non-custodial and the pad
  never routes trades), and whether the **franchise** model crosses into "placing crypto-assets".
- Practical stance until reviewed: EU users get software and data; the pad does not market tokens, does not
  take fiat, does not hold assets. Keep the launches themselves on third-party venues (pump.fun, Raydium).

## 4. US persons, sanctions, geo
- Geo-block US IPs from paid tiers and from seat applications until counsel clears it; keep the free scanner
  global. Screen seat holders and committee members against OFAC lists (free APIs exist) at vetting time.

## 5. KYC without a KYC product
- Seat holders are identity-verified **privately by the committee** (§2). Decide what is retained:
  the recommendation is *nothing* beyond `identity_verified_at` and the verifying member's signature.
  If a regulator later requires more, a third-party KYC provider can be plugged into the interview step.

## 6. Money in, money out
- Revenue in SOL to a treasury wallet (`TREASURY_WALLET`), converted to EUR on a regulated exchange
  (Bitpanda, Kraken) monthly; book each conversion. Issue an invoice per key request (memo = invoice number).
- Slot-fee pool shares and fines are booked as pass-through ledger lines; the seat pool is paid out per the rulebook and is not company revenue.
- Tax: launch-fee and licence revenue is ordinary revenue with VAT (reverse charge for EU B2B); crypto held in treasury
  is inventory at cost. A tax advisor with crypto experience is a must before the first quarter closes.

## 7. Terms the site needs before charging
- Terms of Service (software, no investment advice, no guarantee of launch outcomes, committee decisions final).
- Scanner disclaimer: results are heuristics from public data; `unknown` means unknown.
- Privacy notice: what the API logs (IP for rate limits, 30 days), what the Telegram bot stores (chat id).
- Impressum/legal page requirement for an EU-facing commercial site: the founder prefers no personal
  Impressum on product sites, so the entity's registered address is the answer, not a private one.

## 8. The committee is not the company
- Committee members are elected by seat holders and paid from the treasury (§9). Draft a short charter:
  term, duties, conflict rules (§8 holdings cap), confidentiality for interviews, and that the committee
  cannot change the rulebook or the fee split.

## 9. Insurance of last resort
- There is no insurance and no protection pool. A ban does not repay holders; say so. Do not use the word insurance
  anywhere on the site or in marketing.

## 10. Hiring plan for $1M ARR
- Year 1: founder + one backend engineer (indexer, scanner accuracy) + one community/ops person who runs
  vetting logistics and the committee calendar. Everything else (design, audit, legal) is contracted.
