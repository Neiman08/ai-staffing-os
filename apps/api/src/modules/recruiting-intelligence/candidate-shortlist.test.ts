import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShortlistEntries,
  isValidShortlistTransition,
  isShortlistReviewStatus,
  SHORTLIST_REVIEW_TRANSITIONS,
  SHORTLIST_VERSION,
  type ShortlistReviewStatus,
  type ShortlistSourceMatch,
} from "./candidate-shortlist";

function match(overrides: Partial<ShortlistSourceMatch> = {}): ShortlistSourceMatch {
  return {
    candidateId: "cand-1",
    rank: 1,
    score: 80,
    normalizedScore: 0.8,
    qualificationStatus: "QUALIFIED",
    confidence: "HIGH",
    explanation: "QUALIFIED: score 80.0/100.",
    risks: [],
    missingData: [],
    ...overrides,
  };
}

test("buildShortlistEntries maps ranked matches 1:1, always starting at DRAFT", () => {
  const entries = buildShortlistEntries([match({ candidateId: "a" }), match({ candidateId: "b", rank: 2 })]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.reviewStatus, "DRAFT");
  assert.equal(entries[1]!.reviewStatus, "DRAFT");
});

test("buildShortlistEntries preserves rank/score/qualificationStatus/confidence from the source match", () => {
  const [entry] = buildShortlistEntries([match({ rank: 3, score: 55.5, normalizedScore: 0.555, qualificationStatus: "NEEDS_REVIEW", confidence: "MEDIUM" })]);
  assert.equal(entry!.rank, 3);
  assert.equal(entry!.score, 55.5);
  assert.equal(entry!.normalizedScore, 0.555);
  assert.equal(entry!.qualificationStatus, "NEEDS_REVIEW");
  assert.equal(entry!.confidence, "MEDIUM");
});

test("buildShortlistEntries maps risks/missingData to gaps/risks and explanation to reasons", () => {
  const [entry] = buildShortlistEntries([match({ explanation: "some explanation", risks: ["risk 1"], missingData: ["state"] })]);
  assert.deepEqual(entry!.reasons, ["some explanation"]);
  assert.deepEqual(entry!.risks, ["risk 1"]);
  assert.deepEqual(entry!.gaps, ["state"]);
});

test("buildShortlistEntries preserves input order (already deterministic from the ranking)", () => {
  const entries = buildShortlistEntries([match({ candidateId: "z", rank: 1 }), match({ candidateId: "a", rank: 2 })]);
  assert.deepEqual(entries.map((e) => e.candidateId), ["z", "a"]);
});

test("buildShortlistEntries stamps the current SHORTLIST_VERSION", () => {
  const [entry] = buildShortlistEntries([match()]);
  assert.equal(entry!.shortlistVersion, SHORTLIST_VERSION);
});

test("buildShortlistEntries on an empty ranked list returns an empty array", () => {
  assert.deepEqual(buildShortlistEntries([]), []);
});

test("isValidShortlistTransition: same-state is always valid (idempotent)", () => {
  const states: ShortlistReviewStatus[] = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "HOLD", "REMOVED"];
  for (const s of states) assert.equal(isValidShortlistTransition(s, s), true);
});

test("isValidShortlistTransition: DRAFT -> READY_FOR_REVIEW -> APPROVED is a valid path", () => {
  assert.equal(isValidShortlistTransition("DRAFT", "READY_FOR_REVIEW"), true);
  assert.equal(isValidShortlistTransition("READY_FOR_REVIEW", "APPROVED"), true);
});

test("isValidShortlistTransition: REMOVED can always reopen to DRAFT -- never a permanent rejection", () => {
  assert.equal(isValidShortlistTransition("REMOVED", "DRAFT"), true);
});

test("isValidShortlistTransition: REMOVED cannot jump directly to APPROVED (must reopen to DRAFT first)", () => {
  assert.equal(isValidShortlistTransition("REMOVED", "APPROVED"), false);
});

test("isValidShortlistTransition: DRAFT cannot jump directly to APPROVED (must pass through READY_FOR_REVIEW)", () => {
  assert.equal(isValidShortlistTransition("DRAFT", "APPROVED"), false);
});

test("isValidShortlistTransition: every state can reach REMOVED directly (a shortlist entry can always be pulled)", () => {
  const states: ShortlistReviewStatus[] = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "HOLD"];
  for (const s of states) assert.equal(isValidShortlistTransition(s, "REMOVED"), true);
});

test("SHORTLIST_REVIEW_TRANSITIONS never permanently strands REMOVED (always has an outgoing edge)", () => {
  assert.ok(SHORTLIST_REVIEW_TRANSITIONS.REMOVED.length > 0);
});

test("isShortlistReviewStatus: accepts all 5 valid states, rejects garbage/wrong-case/non-string input", () => {
  const valid: ShortlistReviewStatus[] = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "HOLD", "REMOVED"];
  for (const v of valid) assert.equal(isShortlistReviewStatus(v), true);
  assert.equal(isShortlistReviewStatus("draft"), false);
  assert.equal(isShortlistReviewStatus("APPROVED_BY_HACKER"), false);
  assert.equal(isShortlistReviewStatus(null), false);
  assert.equal(isShortlistReviewStatus(42), false);
});
