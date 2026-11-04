import assert from "node:assert/strict";
import { buildTree, proofFor, verifyProof, distribute, scoreSeats, seatScore } from "../src/index.js";

// payout tree round-trip
const holders = [
  { owner: "9HRpTs1C5FxbqtjvaAKmKQftMWAUsuNY63Di8E3dxreT", amount: 5_000n },
  { owner: "HfUHFPvfbgexAxC1sR5S97kGxNwYWvYDXmuPbAzMSa96", amount: 3_000n },
  { owner: "EHUrEMswBZQuiTvLHspKQ7P1UpouvWZ2xUEoT7KbcavH", amount: 2_000n },
];
const leaves = distribute(50n * 1_000_000_000n, holders);
assert.equal(leaves.reduce((a, l) => a + l.lamports, 0n), 50n * 1_000_000_000n, "pot distributed exactly");
const tree = buildTree(leaves);
for (const l of leaves) assert.ok(verifyProof(tree.root, l, proofFor(tree, l.index)), `proof ${l.index}`);
assert.ok(!verifyProof(tree.root, { ...leaves[0], lamports: leaves[0].lamports + 1n }, proofFor(tree, 0)), "tampered leaf fails");

// scoring
assert.equal(seatScore({ survivalPct: 88, holderOutcomePct: 74, medianPeakX: 7.7, warnings: 0 }), 83);
const row = (seat: number, m: Partial<{ survivalPct: number; holderOutcomePct: number; medianPeakX: number; warnings: number; launches: number }>, extra: Partial<{ noticeSeasons: number; cleanSeasons: number }> = {}) =>
  ({ seat, developer: "D" + seat, wallet: "w" + seat, since: "S0", metrics: { survivalPct: 88, holderOutcomePct: 74, medianPeakX: 7.7, warnings: 0, launches: 2, ...m }, noticeSeasons: 0, cleanSeasons: 1, ...extra });
// three seats only: no bottom-two (needs half the pad with a record), but the threshold still bites
const few = scoreSeats([row(1, {}), row(2, { survivalPct: 44, holderOutcomePct: 41, medianPeakX: 2.2, warnings: 1 }, { noticeSeasons: 2, cleanSeasons: 0 }), row(3, { survivalPct: 20, holderOutcomePct: 20, medianPeakX: 1.2, warnings: 2 }, { noticeSeasons: 1, cleanSeasons: 0 })]);
assert.equal(few.find((s) => s.seat === 2)!.status, "seated", "score 44 with only three seats: no bottom-two yet");
assert.equal(few.find((s) => s.seat === 3)!.status, "notice", "score under 40 is on notice at any size");
// a full pad: bottom two are on notice, a seat with no settled launch is provisional and never on notice
const full = scoreSeats([...Array.from({ length: 10 }, (_, i) => row(i + 1, {})), row(11, { survivalPct: 50, holderOutcomePct: 55, medianPeakX: 2 }), row(12, { survivalPct: 52, holderOutcomePct: 58, medianPeakX: 2.5 }), row(13, { survivalPct: 0, holderOutcomePct: 0, medianPeakX: 0, launches: 0 })]);
assert.deepEqual(full.filter((s) => s.status === "notice").map((s) => s.seat).sort(), [11, 12]);
assert.equal(full.find((s) => s.seat === 13)!.provisional, true); assert.equal(full.find((s) => s.seat === 13)!.status, "seated");
assert.equal(seatScore({ survivalPct: 100, holderOutcomePct: 100, medianPeakX: 10, warnings: 0, banned: true }), 85, "a banned seat scores 0 on conduct");
console.log("shared: all tests passed");
