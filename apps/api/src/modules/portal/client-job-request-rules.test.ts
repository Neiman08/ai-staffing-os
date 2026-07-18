import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidClientJobRequestTransition,
  CLIENT_JOB_REQUEST_TRANSITIONS,
  CLIENT_EDITABLE_STATUSES,
  type ClientJobRequestStatus,
} from "./client-job-request-rules";

test("isValidClientJobRequestTransition: same-state is always valid (idempotent)", () => {
  const states: ClientJobRequestStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_INFORMATION", "APPROVED", "CONVERTED_TO_JOB_ORDER", "REJECTED", "CANCELLED"];
  for (const s of states) assert.equal(isValidClientJobRequestTransition(s, s), true);
});

test("full happy path DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED -> CONVERTED_TO_JOB_ORDER is valid", () => {
  assert.equal(isValidClientJobRequestTransition("DRAFT", "SUBMITTED"), true);
  assert.equal(isValidClientJobRequestTransition("SUBMITTED", "UNDER_REVIEW"), true);
  assert.equal(isValidClientJobRequestTransition("UNDER_REVIEW", "APPROVED"), true);
  assert.equal(isValidClientJobRequestTransition("APPROVED", "CONVERTED_TO_JOB_ORDER"), true);
});

test("NEEDS_INFORMATION loops back to SUBMITTED, never straight to UNDER_REVIEW", () => {
  assert.equal(isValidClientJobRequestTransition("NEEDS_INFORMATION", "SUBMITTED"), true);
  assert.equal(isValidClientJobRequestTransition("NEEDS_INFORMATION", "UNDER_REVIEW"), false);
});

test("CANCELLED is reachable from every non-terminal state", () => {
  for (const s of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "NEEDS_INFORMATION"] as const) {
    assert.equal(isValidClientJobRequestTransition(s, "CANCELLED"), true);
  }
});

test("APPROVED/CONVERTED_TO_JOB_ORDER/REJECTED/CANCELLED are terminal -- never CANCELLED once decided", () => {
  assert.deepEqual(CLIENT_JOB_REQUEST_TRANSITIONS.CONVERTED_TO_JOB_ORDER, []);
  assert.deepEqual(CLIENT_JOB_REQUEST_TRANSITIONS.REJECTED, []);
  assert.deepEqual(CLIENT_JOB_REQUEST_TRANSITIONS.CANCELLED, []);
  assert.equal(isValidClientJobRequestTransition("APPROVED", "CANCELLED"), false, "once APPROVED the client can no longer unilaterally cancel");
});

test("DRAFT can never jump straight to APPROVED or CONVERTED_TO_JOB_ORDER, skipping review", () => {
  assert.equal(isValidClientJobRequestTransition("DRAFT", "APPROVED"), false);
  assert.equal(isValidClientJobRequestTransition("DRAFT", "CONVERTED_TO_JOB_ORDER"), false);
});

test("CLIENT_EDITABLE_STATUSES is exactly DRAFT and NEEDS_INFORMATION", () => {
  assert.equal(CLIENT_EDITABLE_STATUSES.has("DRAFT"), true);
  assert.equal(CLIENT_EDITABLE_STATUSES.has("NEEDS_INFORMATION"), true);
  assert.equal(CLIENT_EDITABLE_STATUSES.has("SUBMITTED"), false);
  assert.equal(CLIENT_EDITABLE_STATUSES.has("UNDER_REVIEW"), false);
});
