import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePayrollReadiness } from "./payroll-readiness";

test("alreadyExported always wins, regardless of compliance or entry state", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "BLOCKED",
    timeEntries: [{ status: "DRAFT", overtimeFlag: false, discrepancyFlag: false }],
    alreadyExported: true,
  });
  assert.equal(result.status, "EXPORTED");
  assert.deepEqual(result.blockers, []);
});

test("BLOCKED compliance status blocks readiness even with clean, fully-approved entries", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "BLOCKED",
    timeEntries: [{ status: "APPROVED", overtimeFlag: false, discrepancyFlag: false }],
    alreadyExported: false,
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers[0]?.includes("compliance"));
});

test("no time entries at all is NOT_READY, never invents a period as ready", () => {
  const result = evaluatePayrollReadiness({ workerComplianceStatus: "COMPLIANT", timeEntries: [], alreadyExported: false });
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.blockers[0]?.includes("No time entries"));
});

test("any entry still DRAFT/PENDING/SUBMITTED keeps the period NOT_READY", () => {
  for (const status of ["DRAFT", "PENDING", "SUBMITTED"]) {
    const result = evaluatePayrollReadiness({
      workerComplianceStatus: "COMPLIANT",
      timeEntries: [
        { status: "APPROVED", overtimeFlag: false, discrepancyFlag: false },
        { status, overtimeFlag: false, discrepancyFlag: false },
      ],
      alreadyExported: false,
    });
    assert.equal(result.status, "NOT_READY", `status ${status} should keep it NOT_READY`);
  }
});

test("a REJECTED entry keeps the period NOT_READY, distinctly worded from in-progress entries", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "COMPLIANT",
    timeEntries: [{ status: "REJECTED", overtimeFlag: false, discrepancyFlag: false }],
    alreadyExported: false,
  });
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.blockers[0]?.includes("rejected"));
});

test("a NEEDS_REVIEW entry (with all others resolved) routes to NEEDS_REVIEW, not NOT_READY", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "COMPLIANT",
    timeEntries: [
      { status: "APPROVED", overtimeFlag: false, discrepancyFlag: false },
      { status: "NEEDS_REVIEW", overtimeFlag: false, discrepancyFlag: true },
    ],
    alreadyExported: false,
  });
  assert.equal(result.status, "NEEDS_REVIEW");
});

test("all entries APPROVED/LOCKED with no flags is READY_FOR_EXPORT with no review notes", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "COMPLIANT",
    timeEntries: [
      { status: "APPROVED", overtimeFlag: false, discrepancyFlag: false },
      { status: "LOCKED", overtimeFlag: false, discrepancyFlag: false },
    ],
    alreadyExported: false,
  });
  assert.equal(result.status, "READY_FOR_EXPORT");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.reviewNotes, []);
});

test("all entries resolved but one carries an overtime flag stays READY_FOR_EXPORT with an informational reviewNote (never blocking)", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "COMPLIANT",
    timeEntries: [{ status: "APPROVED", overtimeFlag: true, discrepancyFlag: false }],
    alreadyExported: false,
  });
  assert.equal(result.status, "READY_FOR_EXPORT");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.reviewNotes.length, 1);
});

test("PENDING/compliance status of a COMPLIANT worker never blocks -- only BLOCKED does", () => {
  const result = evaluatePayrollReadiness({
    workerComplianceStatus: "PENDING",
    timeEntries: [{ status: "APPROVED", overtimeFlag: false, discrepancyFlag: false }],
    alreadyExported: false,
  });
  assert.equal(result.status, "READY_FOR_EXPORT");
});
