import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOvertimeFlag,
  computeDiscrepancyFlag,
  computeShiftScheduledHours,
  isValidTimeEntryStatusTransition,
  computeSubmissionTargetStatus,
  TIME_ENTRY_STATUS_TRANSITIONS,
  type TimeEntryStatusExtended,
} from "./time-entry-signals";

test("computeOvertimeFlag: false when total hours <= 8 and no overtime/double declared", () => {
  assert.equal(computeOvertimeFlag({ regularHours: 8, overtimeHours: 0, doubleHours: 0 }), false);
  assert.equal(computeOvertimeFlag({ regularHours: 6, overtimeHours: 0, doubleHours: 0 }), false);
});

test("computeOvertimeFlag: true when total hours exceed 8, even with zero explicit overtimeHours", () => {
  assert.equal(computeOvertimeFlag({ regularHours: 9, overtimeHours: 0, doubleHours: 0 }), true);
});

test("computeOvertimeFlag: true whenever overtimeHours or doubleHours are explicitly declared, regardless of total", () => {
  assert.equal(computeOvertimeFlag({ regularHours: 4, overtimeHours: 1, doubleHours: 0 }), true);
  assert.equal(computeOvertimeFlag({ regularHours: 4, overtimeHours: 0, doubleHours: 1 }), true);
});

test("computeShiftScheduledHours: same-day shift computes correctly", () => {
  assert.equal(computeShiftScheduledHours("09:00", "17:00", 0), 8);
  assert.equal(computeShiftScheduledHours("09:00", "17:00", 30), 7.5);
});

test("computeShiftScheduledHours: overnight shift crossing midnight computes correctly", () => {
  assert.equal(computeShiftScheduledHours("22:00", "06:00", 0), 8);
});

test("computeDiscrepancyFlag: no scheduled shift means no discrepancy ever (never invents an expectation)", () => {
  const result = computeDiscrepancyFlag({ regularHours: 12, overtimeHours: 0, doubleHours: 0 }, null);
  assert.equal(result.flag, false);
  assert.equal(result.notes, null);
});

test("computeDiscrepancyFlag: within threshold of scheduled hours is not a discrepancy", () => {
  const result = computeDiscrepancyFlag({ regularHours: 8.5, overtimeHours: 0, doubleHours: 0 }, { scheduledHours: 8 });
  assert.equal(result.flag, false);
});

test("computeDiscrepancyFlag: beyond threshold of scheduled hours is a real discrepancy, with explanatory notes", () => {
  const result = computeDiscrepancyFlag({ regularHours: 10.5, overtimeHours: 0, doubleHours: 0 }, { scheduledHours: 8 });
  assert.equal(result.flag, true);
  assert.ok(result.notes?.includes("10.5h"));
  assert.ok(result.notes?.includes("8h"));
});

test("isValidTimeEntryStatusTransition: same-state is always valid (idempotent)", () => {
  const states: TimeEntryStatusExtended[] = ["DRAFT", "PENDING", "SUBMITTED", "NEEDS_REVIEW", "APPROVED", "REJECTED", "LOCKED"];
  for (const s of states) assert.equal(isValidTimeEntryStatusTransition(s, s), true);
});

test("isValidTimeEntryStatusTransition: PENDING preserves its original F5.6 transitions (APPROVED, now also REJECTED/LOCKED)", () => {
  assert.equal(isValidTimeEntryStatusTransition("PENDING", "APPROVED"), true);
  assert.equal(isValidTimeEntryStatusTransition("PENDING", "LOCKED"), true);
});

test("isValidTimeEntryStatusTransition: REJECTED always reopens to DRAFT -- never a permanent rejection", () => {
  assert.equal(isValidTimeEntryStatusTransition("REJECTED", "DRAFT"), true);
});

test("isValidTimeEntryStatusTransition: LOCKED is terminal", () => {
  assert.deepEqual(TIME_ENTRY_STATUS_TRANSITIONS.LOCKED, []);
});

test("isValidTimeEntryStatusTransition: DRAFT cannot jump straight to APPROVED (must go through SUBMITTED/NEEDS_REVIEW)", () => {
  assert.equal(isValidTimeEntryStatusTransition("DRAFT", "APPROVED"), false);
});

test("computeSubmissionTargetStatus: discrepancy routes to NEEDS_REVIEW, otherwise SUBMITTED", () => {
  assert.equal(computeSubmissionTargetStatus(true), "NEEDS_REVIEW");
  assert.equal(computeSubmissionTargetStatus(false), "SUBMITTED");
});
