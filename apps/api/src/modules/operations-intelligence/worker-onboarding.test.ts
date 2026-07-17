import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOnboardingProgress,
  isValidOnboardingTransition,
  WORKER_ONBOARDING_TRANSITIONS,
  WORKER_ONBOARDING_VERSION,
  type OnboardingProgressInput,
  type OnboardingStatus,
} from "./worker-onboarding";

function input(overrides: Partial<OnboardingProgressInput> = {}): OnboardingProgressInput {
  return {
    status: "IN_PROGRESS",
    placementReadinessStatus: "READY_FOR_APPROVAL",
    hasExistingWorker: false,
    workerComplianceStatus: null,
    ...overrides,
  };
}

test("isValidOnboardingTransition: same-state is always valid (idempotent)", () => {
  const states: OnboardingStatus[] = ["INVITED", "IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW", "READY", "ACTIVE", "BLOCKED", "OFFBOARDED"];
  for (const s of states) assert.equal(isValidOnboardingTransition(s, s), true);
});

test("isValidOnboardingTransition: full happy path INVITED -> ... -> ACTIVE", () => {
  assert.equal(isValidOnboardingTransition("INVITED", "IN_PROGRESS"), true);
  assert.equal(isValidOnboardingTransition("IN_PROGRESS", "DOCUMENTS_PENDING"), true);
  assert.equal(isValidOnboardingTransition("DOCUMENTS_PENDING", "COMPLIANCE_REVIEW"), true);
  assert.equal(isValidOnboardingTransition("COMPLIANCE_REVIEW", "READY"), true);
  assert.equal(isValidOnboardingTransition("READY", "ACTIVE"), true);
});

test("isValidOnboardingTransition: cannot skip stages (INVITED -> READY directly is invalid)", () => {
  assert.equal(isValidOnboardingTransition("INVITED", "READY"), false);
});

test("isValidOnboardingTransition: BLOCKED is reachable from every non-terminal state and can reopen to IN_PROGRESS", () => {
  const states: OnboardingStatus[] = ["INVITED", "IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW", "READY", "ACTIVE"];
  for (const s of states) assert.equal(isValidOnboardingTransition(s, "BLOCKED"), true);
  assert.equal(isValidOnboardingTransition("BLOCKED", "IN_PROGRESS"), true);
});

test("isValidOnboardingTransition: OFFBOARDED is terminal, no outgoing transitions", () => {
  assert.deepEqual(WORKER_ONBOARDING_TRANSITIONS.OFFBOARDED, []);
  assert.equal(isValidOnboardingTransition("OFFBOARDED", "IN_PROGRESS"), false);
});

test("isValidOnboardingTransition: BLOCKED cannot jump directly to ACTIVE (must reopen to IN_PROGRESS first)", () => {
  assert.equal(isValidOnboardingTransition("BLOCKED", "ACTIVE"), false);
});

test("evaluateOnboardingProgress: NOT_READY placement readiness is always a blocker", () => {
  const result = evaluateOnboardingProgress(input({ placementReadinessStatus: "NOT_READY" }));
  assert.ok(result.blockers.some((b) => b.includes("NOT_READY")));
});

test("evaluateOnboardingProgress: NEEDS_REVIEW placement readiness is a warning, not a blocker", () => {
  const result = evaluateOnboardingProgress(input({ placementReadinessStatus: "NEEDS_REVIEW" }));
  assert.equal(result.blockers.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("evaluateOnboardingProgress: worker complianceStatus BLOCKED is a blocker, PENDING is a warning", () => {
  const blocked = evaluateOnboardingProgress(input({ hasExistingWorker: true, workerComplianceStatus: "BLOCKED" }));
  assert.ok(blocked.blockers.some((b) => b.includes("BLOCKED")));

  const pending = evaluateOnboardingProgress(input({ hasExistingWorker: true, workerComplianceStatus: "PENDING" }));
  assert.equal(pending.blockers.length, 0);
  assert.ok(pending.warnings.some((w) => w.includes("PENDING")));
});

test("evaluateOnboardingProgress: reaching READY without an existing Worker is a blocker (never auto-creates one)", () => {
  const result = evaluateOnboardingProgress(input({ status: "READY", hasExistingWorker: false }));
  assert.ok(result.blockers.some((b) => b.includes("Worker")));
});

test("evaluateOnboardingProgress: reaching READY with an existing Worker and no other issues has zero blockers", () => {
  const result = evaluateOnboardingProgress(input({ status: "READY", hasExistingWorker: true }));
  assert.equal(result.blockers.length, 0);
});

test("evaluateOnboardingProgress: progress is a fixed, deterministic function of status", () => {
  assert.equal(evaluateOnboardingProgress(input({ status: "INVITED" })).progress, 10);
  assert.equal(evaluateOnboardingProgress(input({ status: "ACTIVE" })).progress, 100);
  assert.equal(evaluateOnboardingProgress(input({ status: "OFFBOARDED" })).progress, 0);
});

test("evaluateOnboardingProgress: requiresApproval is always true -- never authorizes an automatic action", () => {
  assert.equal(evaluateOnboardingProgress(input({ status: "READY", hasExistingWorker: true })).requiresApproval, true);
  assert.equal(evaluateOnboardingProgress(input({ status: "ACTIVE" })).requiresApproval, true);
});

test("evaluateOnboardingProgress: nextBestAction is deterministic and non-empty for every status", () => {
  const states: OnboardingStatus[] = ["INVITED", "IN_PROGRESS", "DOCUMENTS_PENDING", "COMPLIANCE_REVIEW", "READY", "ACTIVE", "BLOCKED", "OFFBOARDED"];
  for (const s of states) {
    const result = evaluateOnboardingProgress(input({ status: s, hasExistingWorker: true }));
    assert.ok(result.nextBestAction.length > 0);
  }
});

test("evaluateOnboardingProgress is deterministic: same input twice produces an identical result", () => {
  const i = input({ status: "COMPLIANCE_REVIEW", placementReadinessStatus: "NEEDS_REVIEW" });
  assert.deepEqual(evaluateOnboardingProgress(i), evaluateOnboardingProgress(i));
});

test("rulesVersion is stable", () => {
  assert.equal(evaluateOnboardingProgress(input()).rulesVersion, WORKER_ONBOARDING_VERSION);
});
