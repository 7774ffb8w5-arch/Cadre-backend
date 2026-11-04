/** web/dev.js must build byte-identical signed messages and canonical JSON to @twenty/shared. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { signedMessage, canonicalJson } from "@twenty/shared";

const src = readFileSync(new URL("../../../web/dev.js", import.meta.url), "utf8");
const pick = (name: string) => { const m = src.match(new RegExp(`(?:const|function) ${name}\\b[^\\n]*`)); if (!m) throw new Error(name + " not found in dev.js"); return m[0]; };

test("signedMessage and canonicalJson match the server", () => {
  const sandbox: Record<string, unknown> = {}; vm.createContext(sandbox);
  vm.runInContext(pick("signedMessage") + "\n" + pick("canonicalJson") + "\nthis.sm = signedMessage; this.cj = canonicalJson;", sandbox);
  const sm = sandbox.sm as typeof signedMessage, cj = sandbox.cj as typeof canonicalJson;
  assert.equal(sm("book slot", "W", "N", "2026-01-01T00:00:00.000Z", "H"), signedMessage("book slot", "W", "N", "2026-01-01T00:00:00.000Z", "H"));
  const body = { wallets: [{ pct: 1, address: "x", label: "y" }], mint: "m", liquidity: "burned", nested: { b: 2, a: [1, null, "s"] } };
  assert.equal(cj(body), canonicalJson(body)); assert.equal(cj(null), canonicalJson(null)); assert.equal(cj({}), "{}");
});
