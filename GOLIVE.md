# Go-live: von null bis online (Schritt für Schritt)

Reihenfolge: **A Vorbereitung → B Devnet-Probelauf → C Website → D Mainnet → E Start**.
Mainnet erst, wenn Devnet komplett durch ist. Gesamtzeit realistisch: Devnet 1 Tag, Mainnet nach Audit.

## A · Vorbereitung (ca. 1–2 h)

1. **Domain** kaufen (z. B. `cadre-us.org`). Zwei Namen planen: `cadre-us.org` (Website) und `api.cadre-us.org` (Backend).
2. **GitHub**: privates Repo anlegen, Projekt hochladen (`.env*`-Dateien und `keys/` nie committen).
3. **Konten**: Railway (Backend + Postgres), Cloudflare Pages oder Netlify (Website), Helius (RPC + Webhook), Telegram.
4. **Telegram-Bot**: @BotFather → `/newbot` → Token = `TELEGRAM_BOT_TOKEN`. Öffentlichen Kanal anlegen (z. B. `@cadre_alerts`), Bot als Admin mit „Nachrichten posten" hinzufügen → `TELEGRAM_ALERTS_CHANNEL=@cadre_alerts`.
5. **Schlüssel erzeugen** (lokal, Solana CLI installiert):
   ```
   mkdir keys
   solana-keygen new -o keys/deployer.json      # zahlt das Programm-Deploy (ca. 4 SOL Devnet / mehr Mainnet)
   solana-keygen new -o keys/treasury.json      # empfängt die 3-SOL-Gebühren  (Mainnet: Hardware-Wallet/Multisig!)
   solana-keygen new -o keys/oracle.json        # schreibt täglich die Scores (ca. 1 SOL für Gebühren)
   solana-keygen new -o keys/committee-1.json   # … bis committee-5.json (später echte Wallets der 5 Mitglieder)
   npx web-push generate-vapid-keys             # VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
   openssl rand -hex 32                         # → KEY_PEPPER   (einmal setzen, nie ändern)
   openssl rand -hex 32                         # → HELIUS_WEBHOOK_SECRET
   ```
6. `KEY_PEPPER` und alle Keys in einem Passwortmanager sichern. Verlust des Oracle-/Deployer-Keys = kein Schreiben/Upgrade mehr.

## B · Devnet-Probelauf (alles mit Spielgeld, `AMOUNT_SCALE=100`: Gebühr 0,03 SOL)

1. **Programm**: `cd program && anchor keys sync && anchor build && anchor deploy --provider.cluster devnet --provider.wallet ../keys/deployer.json`
2. **Pad initialisieren** (einmalig, nur der Upgrade-Authority-Key kann es):
   ```
   npm run program:init -- --payer keys/deployer.json --committee keys/committee-1.json,…,keys/committee-5.json --oracle keys/oracle.json
   … dasselbe mit --send
   ```
3. **Env-Datei**: `cp .env.devnet.example .env.devnet`, ausfüllen (siehe Variablenliste unten), dann
   `npm run devnet:check -- --env .env.devnet` → **muss grün sein**.
4. **Railway**: neues Projekt → Postgres-Plugin → drei Services aus dem Repo (Dockerfile `infra/Dockerfile`):
   | Service | Startkommando | Besonderheit |
   |---|---|---|
   | `api` | `node packages/api/dist/server.js` | Healthcheck-Pfad `/ready`, öffentliche Domain `api-dev…` |
   | `jobs` | `node packages/api/dist/jobs/runner.js` | kein Healthcheck, kein öffentlicher Port |
   | `bot` | `node packages/bot/dist/index.js` | kein öffentlicher Port |
5. **Datenbank anlegen**: einmal `npm run db:migrate` gegen die Railway-`DATABASE_URL` (idempotent, bei jedem Update erneut ausführbar).
6. **Komitee eintragen** (die 5 Wallets, die später Entscheidungen signieren; ohne diese Zeilen kann niemand abstimmen):
   ```sql
   insert into committee_members(name, wallet, since_season, term_end_season, focus) values
    ('Name 1','<Wallet 1>',1,3,'on-chain forensics'), ('Name 2','<Wallet 2>',1,3,'market structure'),
    ('Name 3','<Wallet 3>',1,3,'community'), ('Name 4','<Wallet 4>',1,3,'legal'), ('Name 5','<Wallet 5>',1,3,'operations');
   ```
7. **Helius-Webhook** (Devnet): Typ „Enhanced", Account-Adressen = Treasury + Seat-Wallets, URL `https://api-dev…/v1/webhooks/helius`, Header `Authorization: <HELIUS_WEBHOOK_SECRET>`.
8. **Gesundheit prüfen**: `https://api-dev…/v1/health` → alle Komponenten `operational` (Programm erst nach Deploy, Markt erst nach dem ersten Snapshot).
9. **Seats füllen** (Gründungsrunde): Bewerbungen kommen über die Website (`#apply`) → Komitee entscheidet (3 von 5) „Seat" für einen freien Platz → Seat zugewiesen. Für den Probelauf genügen 2–3 Test-Wallets.
10. **Checkliste aus `docs/DEVNET.md` §6 komplett abhaken** (Verbinden, Slot buchen + zahlen, Ablehnen, Reminder-Push, Launch, Reports, Challenge, Ban, Season-Ende, `/v1/status` grün).
11. **Telegram testen**: `/start`, `/leaderboard`, `/watch 1`, `/alerts`, dann einen Slot buchen und prüfen, dass die Meldung ankommt.

## C · Website online

1. `web/config.js` setzen (Produktion):
   ```js
   window.TWENTY_CONFIG = { API_BASE: "https://api.cadre-us.org", SITE_URL: "https://cadre-us.org", TREASURY: "<Treasury-Adresse>" };
   ```
   **`TREASURY` ist wichtig**: die Seite verweigert dann jede Zahlung, die nicht exakt an diese Adresse geht.
2. CSP neu stempeln – der API-Host muss darin stehen:
   `API_ORIGIN=https://api.cadre-us.org node web/build.mjs`
   (Ohne diesen Schritt blockiert der Browser alle API-Aufrufe.)
3. Hochladen: den Inhalt von `web/` (index.html, status.html, status.js, config.js, dev.js, live.js, push.js, qr.js, og.js, og.png, sw.js, manifest.webmanifest, icons/, brand/ und **`_headers`**) auf Cloudflare Pages/Netlify. Domain verbinden, HTTPS prüfen.
4. Prüfen: Seite lädt mit Live-Daten, Konsole ohne rote Fehler, `/status.html` zeigt grün, Wallet-Verbinden funktioniert, Push-Anmeldung funktioniert (nur über https).
5. Social-Vorschau: Link in X/Telegram einfügen (Bild `og.png`).

## D · Mainnet (erst nach Audit + vollem Devnet-Durchlauf)

1. Externes **Audit/Review** des Anchor-Programms; mindestens eine komplette beschleunigte Season auf Devnet.
2. Mainnet-Keys: Treasury und Deployer/Upgrade-Authority auf **Hardware-Wallet oder Multisig**. Oracle-Key separat mit wenig SOL.
3. Programm **ohne** `--features devnet` bauen und auf Mainnet deployen, danach sofort `program:init` (mit `--i-know-this-is-mainnet`).
4. Neue Railway-Umgebung „production": `SOLANA_CLUSTER=mainnet-beta`, **kein** `AMOUNT_SCALE`, Mainnet-RPC, neue Secrets, neue Datenbank, `npm run db:migrate`, Komitee eintragen.
5. `npm run devnet:check -- --env .env.mainnet --cluster mainnet-beta` → muss komplett grün sein.
6. Helius-Webhook für Mainnet neu anlegen (Treasury + Seat-Wallets).
7. Website mit Produktions-`config.js` (Schritt C) neu deployen.
8. Rechtliches vorher mit einem Anwalt durchgehen (`docs/COMPANY.md`): Impressum/Datenschutz, keine Verwahrung von Geldern, keine Renditeversprechen.

## E · Start

1. 20 Seats über die Gründungsrunde vergeben, Komitee live auf echten Signaturen proben.
2. Erst dann ankündigen: Video/Bilder aus `cadre-ads/`, Telegram-Kanal und X-Account verlinken (Handle auf Website und Video-Endkarte eintragen).
3. Täglich 2 Minuten: `/v1/health`, `/v1/status`, Telegram-Kanal (siehe `docs/OPERATIONS.md`).

## Variablen (Railway)

**Alle drei Services:** `DATABASE_URL`, `SOLANA_CLUSTER`, `HELIUS_API_KEY`, `SOLANA_RPC_URL`, `KEY_PEPPER`, `TREASURY_WALLET`, `PROGRAM_ID`, `SEASON_ANCHOR_UTC`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:du@domain`), `PUBLIC_SITE_URL`.
**Zusätzlich api:** `PUBLIC_BASE_URL`, `CORS_ORIGINS` (= Website-URL), `TRUST_PROXY=true` (hinter Railway), `HELIUS_WEBHOOK_SECRET`, `BILLING_WATCHER=0`, `PORT=8080`.
**Zusätzlich jobs:** `SCORE_ORACLE_KEYPAIR` (auf Railway den kompletten Inhalt von `keys/oracle.json` einfügen, das 64-Zahlen-Array `[12,34,…]`; lokal geht auch ein Dateipfad), `HELIUS_WEBHOOK_SECRET`.
**Zusätzlich bot:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERTS_CHANNEL`.
**Nur Devnet:** `AMOUNT_SCALE=100`. **Nie auf Mainnet.**

## Wenn etwas nicht geht

| Symptom | Ursache / Lösung |
|---|---|
| Seite zeigt nur Beispieldaten | `API_BASE` in `config.js` leer oder falsch |
| Konsole: „blocked by CSP … connect-src" | `API_ORIGIN=… node web/build.mjs` vergessen |
| Zahlung bleibt „pending" | Memo muss exakt `SLOT-XXXXXXXX` sein; Helius-Webhook/Billing-Job prüfen (`/v1/status`) |
| Kein Push | VAPID-Keys auf `api` **und** `bot`; Seite nur über https |
| Telegram schweigt | Bot im Kanal Admin? `TELEGRAM_ALERTS_CHANNEL` mit `@`; `bot`-Service-Logs |
| `/v1/health` rot bei „market" | Noch kein Snapshot oder Helius-Limit; nach 6 h erneut prüfen |
| Scores fehlen | Job `scores` (00:05 UTC); manuell `npm run -w @twenty/api cron:score` |
