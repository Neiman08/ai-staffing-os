import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPlacementTransition,
  isValidPlacementTransition,
  PLACEMENT_TRANSITIONS,
  PLACEMENT_VERSION,
  type PlacementStatus,
  type PlacementTransitionCheckInput,
} from "./placement";

function input(overrides: Partial<PlacementTransitionCheckInput> = {}): PlacementTransitionCheckInput {
  return { targetStatus: "PENDING_APPROVAL", payRate: 20, billRate: 30, placementReadinessStatus: "READY_FOR_APPROVAL", ...overrides };
}

test("isValidPlacementTransition: same-state is always valid (idempotent)", () => {
  const states: PlacementStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "READY_FOR_ONBOARDING", "ACTIVE", "COMPLETED", "CANCELLED"];
  for (const s of states) assert.equal(isValidPlacementTransition(s, s), true);
});

test("isValidPlacementTransition: full happy path DRAFT -> ... -> ACTIVE -> COMPLETED", () => {
  assert.equal(isValidPlacementTransition("DRAFT", "PENDING_APPROVAL"), true);
  assert.equal(isValidPlacementTransition("PENDING_APPROVAL", "APPROVED"), true);
  assert.equal(isValidPlacementTransition("APPROVED", "READY_FOR_ONBOARDING"), true);
  assert.equal(isValidPlacementTransition("READY_FOR_ONBOARDING", "ACTIVE"), true);
  assert.equal(isValidPlacementTransition("ACTIVE", "COMPLETED"), true);
});

test("isValidPlacementTransition: cannot skip straight from DRAFT to ACTIVE", () => {
  assert.equal(isValidPlacementTransition("DRAFT", "ACTIVE"), false);
});

test("isValidPlacementTransition: CANCELLED is reachable from every non-terminal state and reopens only to DRAFT", () => {
  const states: PlacementStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "READY_FOR_ONBOARDING", "ACTIVE"];
  for (const s of states) assert.equal(isValidPlacementTransition(s, "CANCELLED"), true);
  assert.deepEqual(PLACEMENT_TRANSITIONS.CANCELLED, ["DRAFT"]);
});

test("isValidPlacementTransition: COMPLETED is terminal", () => {
  assert.deepEqual(PLACEMENT_TRANSITIONS.COMPLETED, []);
});

test("checkPlacementTransition: missing payRate or billRate blocks any advance past DRAFT/CANCELLED", () => {
  const noPay = checkPlacementTransition(input({ payRate: null }));
  assert.equal(noPay.allowed, false);
  assert.ok(noPay.blockers.some((b) => b.includes("payRate")));

  const noBill = checkPlacementTransition(input({ billRate: null }));
  assert.equal(noBill.allowed, false);
});

test("checkPlacementTransition: moving to DRAFT or CANCELLED never requires compensation to be set", () => {
  const toDraft = checkPlacementTransition(input({ targetStatus: "DRAFT", payRate: null, billRate: null }));
  assert.equal(toDraft.allowed, true);

  const toCancelled = checkPlacementTransition(input({ targetStatus: "CANCELLED", payRate: null, billRate: null }));
  assert.equal(toCancelled.allowed, true);
});

test("checkPlacementTransition: NOT_READY blocks any operational status (APPROVED/READY_FOR_ONBOARDING/ACTIVE)", () => {
  for (const target of ["APPROVED", "READY_FOR_ONBOARDING", "ACTIVE"] as PlacementStatus[]) {
    const result = checkPlacementTransition(input({ targetStatus: target, placementReadinessStatus: "NOT_READY" }));
    assert.equal(result.allowed, false, `${target} must be blocked when NOT_READY`);
  }
});

test("checkPlacementTransition: non-READY_FOR_APPROVAL readiness is a warning (not a blocker) for operational statuses", () => {
  const result = checkPlacementTransition(input({ targetStatus: "APPROVED", placementReadinessStatus: "CONDITIONALLY_READY" }));
  assert.equal(result.allowed, true);
  assert.ok(result.warnings.length > 0);
});

test("checkPlacementTransition: PENDING_APPROVAL is allowed with valid compensation regardless of readiness warnings", () => {
  const result = checkPlacementTransition(input({ targetStatus: "PENDING_APPROVAL", placementReadinessStatus: "NEEDS_REVIEW" }));
  assert.equal(result.allowed, true);
});

test("checkPlacementTransition: fully valid transition to ACTIVE has zero blockers and zero warnings", () => {
  const result = checkPlacementTransition(input({ targetStatus: "ACTIVE", payRate: 20, billRate: 30, placementReadinessStatus: "READY_FOR_APPROVAL" }));
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("PLACEMENT_VERSION is a stable exported constant", () => {
  assert.equal(typeof PLACEMENT_VERSION, "number");
});
