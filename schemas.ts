/** JSON schemas shared by the route modules. Fastify validates with ajv before any handler runs. */
import { PAD } from "@twenty/shared";

export const B58 = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
export const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const ALERT_EVENTS = ["slot_booked", "launch_live", "report_due", "zone_change", "challenge", "ban"] as const;
const text = (max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max, pattern: "^[^\\p{C}]*$" });
const walletsItem = { type: "object", additionalProperties: false, required: ["label", "address", "pct"], properties: { label: text(24, 0), address: { type: "string", pattern: B58 }, pct: { type: "number", minimum: 0, maximum: 100 } } };

export const S = {
  address: { type: "object", required: ["address"], properties: { address: { type: "string", pattern: B58 } } },
  wallet: { type: "object", required: ["wallet"], properties: { wallet: { type: "string", pattern: B58 } } },
  mint: { type: "object", required: ["mint"], properties: { mint: { type: "string", pattern: B58 } } },
  uuid: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: UUID } } },
  seat: { type: "object", required: ["seat"], properties: { seat: { type: "integer", minimum: 1, maximum: PAD.SEATS } } },
  ref: { type: "object", required: ["ref"], properties: { ref: { type: "string", pattern: "^TW-A-[0-9A-F]{6}$" } } },
  pollId: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" } } },
  logQuery: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 50 }, type: { type: "string", pattern: "^[a-z_]{1,32}$" }, seat: { type: "integer", minimum: 1, maximum: PAD.SEATS } } },
  waitlistBody: { type: "object", additionalProperties: false, required: ["contact"], properties: { contact: { type: "string", minLength: 3, maxLength: 120 }, source: { type: "string", pattern: "^[a-z0-9_-]{1,24}$", default: "site" } } },
  voteBody: { type: "object", additionalProperties: false, required: ["option"], properties: { option: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" }, wallet: { type: "string", pattern: B58 } } },
  ballotBody: { type: "object", additionalProperties: false, required: ["wallet", "candidate", "signature", "nonce", "issued_at"], properties: {
    wallet: { type: "string", pattern: B58 }, candidate: { type: "string", pattern: "^@?[A-Za-z0-9_]{1,32}$" }, signature: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{64,128}$" },
    nonce: { type: "string", pattern: "^[A-Za-z0-9_-]{16,64}$" }, issued_at: { type: "string", format: "date-time", maxLength: 40 } } },
  /* developer routes */
  bookBody: { type: "object", additionalProperties: false, required: ["slot_at"], properties: { slot_at: { type: "string", format: "date-time", maxLength: 40 } } },
  launchBody: { type: "object", additionalProperties: false, required: ["mint", "liquidity"], properties: {
    mint: { type: "string", pattern: B58 }, ticker: { type: "string", pattern: "^[A-Za-z0-9$]{1,13}$" }, dev_allocation_pct: { type: "number", minimum: 0, maximum: PAD.DEV_ALLOCATION_MAX_PCT },
    liquidity: text(80), wallets: { type: "array", maxItems: 20, items: walletsItem } } },  // no defaults on signed routes: the body hash must match what the wallet signed
  discloseBody: { type: "object", additionalProperties: false, minProperties: 1, properties: {
    ticker: { type: "string", pattern: "^[A-Za-z0-9$]{1,13}$" }, dev_allocation_pct: { type: "number", minimum: 0, maximum: PAD.DEV_ALLOCATION_MAX_PCT }, liquidity: text(80), wallets: { type: "array", maxItems: 20, items: walletsItem } } },
  reportParams: { type: "object", required: ["mint", "which"], properties: { mint: { type: "string", pattern: B58 }, which: { type: "integer", enum: [7, 30] } } },
  reportBody: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", pattern: "^https://[^\\s]{4,300}$" } } },
  applyBody: { type: "object", additionalProperties: false, required: ["handle", "mints", "contact"], properties: {
    handle: { type: "string", pattern: "^@?[A-Za-z0-9_]{3,32}$" }, mints: { type: "array", minItems: PAD.APPLY_MIN_LAUNCHES, maxItems: 12, uniqueItems: true, items: { type: "string", pattern: B58 } }, contact: text(120, 3) } },
  flagBody: { type: "object", additionalProperties: false, required: ["claim", "evidence"], properties: { claim: text(400, 10), evidence: { type: "array", minItems: 1, maxItems: 10, items: text(200, 8) } } },
  challengeBody: { type: "object", additionalProperties: false, required: ["seat", "kind"], properties: { seat: { type: "integer", minimum: 1, maximum: PAD.SEATS }, kind: { type: "string", enum: ["signal", "filed"] }, evidence: text(1500, 0) } },
  holderVoteBody: { type: "object", additionalProperties: false, required: ["vote"], properties: { vote: { type: "string", enum: ["keep", "replace"] } } },
  candidacyBody: { type: "object", additionalProperties: false, properties: { statement: text(600, 0) } },
  /* committee */
  decisionBody: { type: "object", additionalProperties: false, required: ["type", "subject", "outcome"], properties: {
    type: { type: "string", enum: ["Bench", "Rejected", "Seat", "Season", "Warning", "Fine", "Suspend", "Ban", "Challenge", "Recall", "Bounty", "Election"] },
    subject: text(120, 3), outcome: text(400, 3), payload: { type: "object", additionalProperties: true, maxProperties: 12 }, evidence: { type: "array", maxItems: 10, items: text(300, 1) } } },
  committeeVoteBody: { type: "object", additionalProperties: false, required: ["vote"], properties: { vote: { type: "string", enum: ["for", "against"] } } },
} as const;
