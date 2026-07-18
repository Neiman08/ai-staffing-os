import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIncidentStatusTransition, INCIDENT_STATUS_TRANSITIONS, requiresAtLeastOneRelation, type IncidentStatusValue } from "./incident-rules";

test("isValidIncidentStatusTransition: same-state is always valid (idempotent)", () => {
  const states: IncidentStatusValue[] = ["OPEN", "UNDER_REVIEW", "ACTION_REQUIRED", "RESOLVED", "CLOSED"];
  for (const s of states) assert.equal(isValidIncidentStatusTransition(s, s), true);
});

test("full forward path OPEN -> UNDER_REVIEW -> ACTION_REQUIRED -> RESOLVED -> CLOSED is valid", () => {
  assert.equal(isValidIncidentStatusTransition("OPEN", "UNDER_REVIEW"), true);
  assert.equal(isValidIncidentStatusTransition("UNDER_REVIEW", "ACTION_REQUIRED"), true);
  assert.equal(isValidIncidentStatusTransition("ACTION_REQUIRED", "RESOLVED"), true);
  assert.equal(isValidIncidentStatusTransition("RESOLVED", "CLOSED"), true);
});

test("OPEN can resolve directly for a trivial incident, skipping UNDER_REVIEW/ACTION_REQUIRED", () => {
  assert.equal(isValidIncidentStatusTransition("OPEN", "RESOLVED"), true);
});

test("UNDER_REVIEW and RESOLVED can bounce back for re-review -- never a one-way ratchet", () => {
  assert.equal(isValidIncidentStatusTransition("UNDER_REVIEW", "OPEN"), true);
  assert.equal(isValidIncidentStatusTransition("RESOLVED", "UNDER_REVIEW"), true);
});

test("CLOSED is terminal", () => {
  assert.deepEqual(INCIDENT_STATUS_TRANSITIONS.CLOSED, []);
  assert.equal(isValidIncidentStatusTransition("CLOSED", "OPEN"), false);
});

test("OPEN cannot jump straight to CLOSED, skipping resolution", () => {
  assert.equal(isValidIncidentStatusTransition("OPEN", "CLOSED"), false);
});

test("requiresAtLeastOneRelation: every type except OTHER requires context", () => {
  assert.equal(requiresAtLeastOneRelation("NO_SHOW"), true);
  assert.equal(requiresAtLeastOneRelation("SAFETY"), true);
  assert.equal(requiresAtLeastOneRelation("CLIENT_COMPLAINT"), true);
  assert.equal(requiresAtLeastOneRelation("OTHER"), false);
});
