// Devnet build of the site: copy over config.js on the dev host (never on the production host).
//   API_BASE   the devnet API (https, exact origin)
//   TREASURY   pins the payment destination: the page refuses any prepared transfer that does not pay this address
//   CLUSTER    "devnet" points transaction links at Solscan's devnet view; wallets must be switched to Devnet too
window.TWENTY_CONFIG = { API_BASE: "https://api-dev.cadre-us.org", SITE_URL: "https://dev.cadre-us.org", TREASURY: "", CLUSTER: "devnet" };
