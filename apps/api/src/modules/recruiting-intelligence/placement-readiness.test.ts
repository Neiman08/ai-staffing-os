import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlacementReadiness, PLACEMENT_READINESS_VERSION, type PlacementReadinessInput } from "./placement-readiness";
import type { QualificationEvaluationResult } from "./qualification-rules";

const NOW = new Date("2026-07-17T00:00:00.000Z");

function qualification(overrides: Partial<QualificationEvaluationResult> = {}): QualificationEvaluationResult {
  return {
    hardDisqualifiers: [],
    missingDocuments: [],
    expiredDocuments: [],
    experienceGap: false,
    languageGaps: [],
    strengths: [],
    reasons: ["El candidato cumple todos los requisitos verificables del Job Order."],
    rulesVersion: 1,
    ...overrides,
  };
}

function input(overrides: Partial<PlacementReadinessInput> = {}): PlacementReadinessInput {
  return {
    candidateId: "cand-1",
    jobOrderId: "job-1",
    qualificationStatus: "QUALIFIED",
    qualification: qualification(),
    shortlistReviewStatus: "APPROVED",
    screeningPlanExists: true,
    screeningManualReviewFlags: [],
    interviewPreviewStatus: "APPROVED_FOR_SEND",
    candidateState: "IL",
    jobOrderState: "IL",
    jobOrderStartDate: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

test("READY_FOR_APPROVAL when every check is complete and there are no warnings", () => {
  const result = computePlacementReadiness(input(), NOW);
  assert.equal(result.readinessStatus, "READY_FOR_APPROVAL");
  assert.equal(result.warnings.length, 0);
  assert.equal(result.blockers.length, 0);
});

test("NOT_READY when qualificationStatus is NOT_QUALIFIED, regardless of everything else being complete", () => {
  const result = computePlacementReadiness(input({ qualificationStatus: "NOT_QUALIFIED" }), NOW);
  assert.equal(result.readinessStatus, "NOT_READY");
});

test("NOT_READY when a required document is expired", () => {
  const result = computePlacementReadiness(input({ qualification: qualification({ expiredDocuments: ["forklift_cert"] }) }), NOW);
  assert.equal(result.readinessStatus, "NOT_READY");
});

test("NOT_READY when the interview preview was CANCELLED", () => {
  const result = computePlacementReadiness(input({ interviewPreviewStatus: "CANCELLED" }), NOW);
  assert.equal(result.readinessStatus, "NOT_READY");
});

test("NEEDS_REVIEW when qualificationStatus is NEEDS_REVIEW (recoverable blocker, not a hard NOT_READY)", () => {
  const result = computePlacementReadiness(input({ qualificationStatus: "NEEDS_REVIEW" }), NOW);
  assert.equal(result.readinessStatus, "NEEDS_REVIEW");
});

test("NEEDS_REVIEW when a required document is missing", () => {
  const result = computePlacementReadiness(input({ qualification: qualification({ missingDocuments: ["i9"] }) }), NOW);
  assert.equal(result.readinessStatus, "NEEDS_REVIEW");
});

test("NEEDS_REVIEW when the candidate was REMOVED from the shortlist", () => {
  const result = computePlacementReadiness(input({ shortlistReviewStatus: "REMOVED" }), NOW);
  assert.equal(result.readinessStatus, "NEEDS_REVIEW");
});

test("CONDITIONALLY_READY when there are only soft warnings (e.g. POSSIBLY_QUALIFIED gaps)", () => {
  const result = computePlacementReadiness(input({ qualificationStatus: "POSSIBLY_QUALIFIED" }), NOW);
  assert.equal(result.readinessStatus, "CONDITIONALLY_READY");
});

test("CONDITIONALLY_READY when shortlist/interview haven't been created yet (pending, not blocked)", () => {
  const result = computePlacementReadiness(input({ shortlistReviewStatus: null, interviewPreviewStatus: null }), NOW);
  assert.equal(result.readinessStatus, "CONDITIONALLY_READY");
  assert.ok(result.pendingChecks.includes("shortlist"));
  assert.ok(result.pendingChecks.includes("interview"));
});

test("CONDITIONALLY_READY on a location mismatch between candidate and Job Order state", () => {
  const result = computePlacementReadiness(input({ candidateState: "TX", jobOrderState: "IL" }), NOW);
  assert.equal(result.readinessStatus, "CONDITIONALLY_READY");
  assert.ok(result.warnings.some((w) => w.includes("difiere")));
});

test("missingInformation always documents the absence of candidate compensation data -- never invents a value", () => {
  const result = computePlacementReadiness(input(), NOW);
  assert.ok(result.missingInformation.some((m) => m.includes("compensación")));
});

test("missingInformation documents absent location data when either side has no state, without treating it as a warning", () => {
  const result = computePlacementReadiness(input({ candidateState: null }), NOW);
  assert.ok(result.missingInformation.some((m) => m.includes("ubicación")));
  assert.ok(!result.warnings.some((w) => w.includes("difiere")));
});

test("warns when the Job Order start date has already passed", () => {
  const result = computePlacementReadiness(input({ jobOrderStartDate: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000) }), NOW);
  assert.ok(result.warnings.some((w) => w.includes("ya pasó")));
});

test("warns when start date is imminent and the interview is not yet approved", () => {
  const result = computePlacementReadiness(
    input({ jobOrderStartDate: new Date(NOW.getTime() + 1 * 24 * 60 * 60 * 1000), interviewPreviewStatus: "READY_FOR_APPROVAL" }),
    NOW,
  );
  assert.ok(result.warnings.some((w) => w.includes("día(s)")));
});

test("requiresApproval is always true -- this function never authorizes an automatic action", () => {
  const ready = computePlacementReadiness(input(), NOW);
  const notReady = computePlacementReadiness(input({ qualificationStatus: "NOT_QUALIFIED" }), NOW);
  assert.equal(ready.requiresApproval, true);
  assert.equal(notReady.requiresApproval, true);
});

test("nextBestAction prioritizes NOT_QUALIFIED over every other signal", () => {
  const result = computePlacementReadiness(
    input({ qualificationStatus: "NOT_QUALIFIED", qualification: qualification({ expiredDocuments: ["forklift_cert"] }) }),
    NOW,
  );
  assert.ok(result.nextBestAction.includes("NOT_QUALIFIED"));
});

test("nextBestAction says everything is complete when the state is READY_FOR_APPROVAL", () => {
  const result = computePlacementReadiness(input(), NOW);
  assert.ok(result.nextBestAction.toLowerCase().includes("completos"));
});

test("score is 100 when every applicable check is completed", () => {
  const result = computePlacementReadiness(input(), NOW);
  assert.equal(result.score, 100);
});

test("score decreases when checks are missing or blocked", () => {
  const full = computePlacementReadiness(input(), NOW);
  const partial = computePlacementReadiness(input({ shortlistReviewStatus: null }), NOW);
  assert.ok(partial.score < full.score);
});

test("is deterministic: same input twice produces an identical result", () => {
  const i = input({ qualificationStatus: "POSSIBLY_QUALIFIED" });
  assert.deepEqual(computePlacementReadiness(i, NOW), computePlacementReadiness(i, NOW));
});

test("rulesVersion and evaluatedAt are always present", () => {
  const result = computePlacementReadiness(input(), NOW);
  assert.equal(result.rulesVersion, PLACEMENT_READINESS_VERSION);
  assert.equal(result.evaluatedAt, NOW.toISOString());
});

test("never returns a field resembling Placement/Assignment/Worker creation -- purely advisory shape", () => {
  const result = computePlacementReadiness(input(), NOW);
  const keys = Object.keys(result);
  for (const forbidden of ["placementId", "assignmentId", "workerId", "created", "activated"]) {
    assert.ok(!keys.includes(forbidden));
  }
});
