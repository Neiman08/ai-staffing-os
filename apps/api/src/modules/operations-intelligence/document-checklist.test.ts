import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChecklistFromRequirements,
  isChecklistItemExpired,
  isValidChecklistItemTransition,
  summarizeChecklist,
  CHECKLIST_ITEM_TRANSITIONS,
  type ChecklistItemStatus,
} from "./document-checklist";

test("isValidChecklistItemTransition: same-state is always valid (idempotent)", () => {
  const states: ChecklistItemStatus[] = ["NOT_REQUESTED", "PENDING", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "EXPIRED", "WAIVED"];
  for (const s of states) assert.equal(isValidChecklistItemTransition(s, s), true);
});

test("isValidChecklistItemTransition: full happy path PENDING -> ... -> VERIFIED", () => {
  assert.equal(isValidChecklistItemTransition("PENDING", "SUBMITTED"), true);
  assert.equal(isValidChecklistItemTransition("SUBMITTED", "UNDER_REVIEW"), true);
  assert.equal(isValidChecklistItemTransition("UNDER_REVIEW", "VERIFIED"), true);
});

test("isValidChecklistItemTransition: cannot skip straight from PENDING to VERIFIED", () => {
  assert.equal(isValidChecklistItemTransition("PENDING", "VERIFIED"), false);
});

test("isValidChecklistItemTransition: REJECTED and EXPIRED can always retry back to PENDING", () => {
  assert.equal(isValidChecklistItemTransition("REJECTED", "PENDING"), true);
  assert.equal(isValidChecklistItemTransition("EXPIRED", "PENDING"), true);
});

test("isValidChecklistItemTransition: WAIVED is reachable from every non-terminal state and reopens to NOT_REQUESTED", () => {
  const states: ChecklistItemStatus[] = ["NOT_REQUESTED", "PENDING", "SUBMITTED" as ChecklistItemStatus, "UNDER_REVIEW", "VERIFIED", "REJECTED", "EXPIRED"];
  // SUBMITTED does not go directly to WAIVED per the graph -- verify precisely.
  assert.equal(isValidChecklistItemTransition("SUBMITTED", "WAIVED"), false, "SUBMITTED must resolve via UNDER_REVIEW/PENDING first");
  for (const s of states.filter((x) => x !== "SUBMITTED")) {
    assert.equal(isValidChecklistItemTransition(s, "WAIVED"), true, `${s} -> WAIVED should be valid`);
  }
  assert.equal(isValidChecklistItemTransition("WAIVED", "NOT_REQUESTED"), true);
});

test("CHECKLIST_ITEM_TRANSITIONS never permanently strands WAIVED/REJECTED/EXPIRED", () => {
  assert.ok(CHECKLIST_ITEM_TRANSITIONS.WAIVED.length > 0);
  assert.ok(CHECKLIST_ITEM_TRANSITIONS.REJECTED.length > 0);
  assert.ok(CHECKLIST_ITEM_TRANSITIONS.EXPIRED.length > 0);
});

test("buildChecklistFromRequirements: maps each required document type to a PENDING draft item", () => {
  const drafts = buildChecklistFromRequirements(
    [{ documentTypeId: "dt-1", documentTypeKey: "forklift_cert", documentTypeName: "Forklift Certification" }],
    {},
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.status, "PENDING");
  assert.equal(drafts[0]!.required, true);
  assert.equal(drafts[0]!.label, "Forklift Certification");
});

test("buildChecklistFromRequirements: manualReviewRequired is true only for document types that require expiration", () => {
  const drafts = buildChecklistFromRequirements(
    [
      { documentTypeId: "dt-1", documentTypeKey: "forklift_cert", documentTypeName: "Forklift Certification" },
      { documentTypeId: "dt-2", documentTypeKey: "i9", documentTypeName: "I-9" },
    ],
    { "dt-1": true },
  );
  assert.equal(drafts.find((d) => d.documentTypeId === "dt-1")!.manualReviewRequired, true);
  assert.equal(drafts.find((d) => d.documentTypeId === "dt-2")!.manualReviewRequired, false);
});

test("buildChecklistFromRequirements: empty requirements produce an empty checklist", () => {
  assert.deepEqual(buildChecklistFromRequirements([], {}), []);
});

test("isChecklistItemExpired: only VERIFIED items with a past expiresAt are expired", () => {
  const now = new Date("2026-07-17T00:00:00.000Z");
  assert.equal(isChecklistItemExpired({ status: "VERIFIED", expiresAt: "2026-01-01T00:00:00.000Z" }, now), true);
  assert.equal(isChecklistItemExpired({ status: "VERIFIED", expiresAt: "2027-01-01T00:00:00.000Z" }, now), false);
  assert.equal(isChecklistItemExpired({ status: "VERIFIED", expiresAt: null }, now), false);
  assert.equal(isChecklistItemExpired({ status: "PENDING", expiresAt: "2026-01-01T00:00:00.000Z" }, now), false);
});

test("summarizeChecklist: allSatisfied is true only when every required item is VERIFIED", () => {
  const allVerified = summarizeChecklist([
    { documentTypeKey: "forklift_cert", required: true, status: "VERIFIED" },
    { documentTypeKey: "drug_test", required: true, status: "VERIFIED" },
  ]);
  assert.equal(allVerified.allSatisfied, true);
  assert.equal(allVerified.missing.length, 0);

  const oneMissing = summarizeChecklist([
    { documentTypeKey: "forklift_cert", required: true, status: "VERIFIED" },
    { documentTypeKey: "drug_test", required: true, status: "PENDING" },
  ]);
  assert.equal(oneMissing.allSatisfied, false);
  assert.deepEqual(oneMissing.missing, ["drug_test"]);
});

test("summarizeChecklist: non-required items never count toward totalRequired/missing", () => {
  const result = summarizeChecklist([
    { documentTypeKey: "forklift_cert", required: true, status: "VERIFIED" },
    { documentTypeKey: "optional_cert", required: false, status: "NOT_REQUESTED" },
  ]);
  assert.equal(result.totalRequired, 1);
  assert.equal(result.allSatisfied, true);
});

test("summarizeChecklist: distinguishes expired from missing, and flags pendingReview separately", () => {
  const result = summarizeChecklist([
    { documentTypeKey: "a", required: true, status: "EXPIRED" },
    { documentTypeKey: "b", required: true, status: "UNDER_REVIEW" },
    { documentTypeKey: "c", required: true, status: "NOT_REQUESTED" },
  ]);
  assert.deepEqual(result.expired, ["a"]);
  assert.deepEqual(result.pendingReview, ["b"]);
  assert.ok(result.missing.includes("a"));
  assert.ok(result.missing.includes("b"));
  assert.ok(result.missing.includes("c"));
});

test("summarizeChecklist: empty input is trivially satisfied (no requirements to fail)", () => {
  const result = summarizeChecklist([]);
  assert.equal(result.allSatisfied, true);
  assert.equal(result.totalRequired, 0);
});
