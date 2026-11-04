# web/

`index.html` is the complete site: the published preview wrapped in a standard head (meta, Open Graph,
favicon) plus `config.js` and `live.js`. The only build step is optional: `node web/build.mjs [page.html]`
re-stamps the hash-based Content-Security-Policy (and `_headers` / `infra/nginx-headers.conf`) — run it after
any change to `index.html`, or the browser will refuse the changed inline scripts. If you point `API_BASE` at
another host, add it to `CONNECT` in `build.mjs` first. Host it anywhere static (Cloudflare Pages, Vercel,
S3); put `og.png` next to it.

- `config.js` — set `API_BASE` to the API origin to go live. Empty keeps the built-in sample data.
- `live.js` — when `API_BASE` is set, replaces the sample data with `/v1/pad|seats|slots|launches|log`
  before the first render, refreshes every 60 s and routes the scanner to `/v1/scan/:address`.
- `og.png` — generated share image (the Season recap card); regenerate with `node og.js` after a season.

- `qr.js` — dependency-free QR encoder (byte mode, ECC M, up to 213 bytes) used for Solana Pay links in the payment card.
- `dev.js` — wallet picker and signed writes; one-tap payment (`/v1/pay/prepare`, transaction check, status stepper). Optional `TWENTY_CONFIG.TREASURY` pins the payment destination; `CLUSTER: "devnet"` points transaction links at devnet.
- `push.js` + `sw.js` — browser notifications. The API needs `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`); the site must be served over https (or localhost). `sw.js` is push-only — it caches nothing. 

