import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInterviewPreview,
  computeInterviewPreviewStatus,
  isValidInterviewPreviewTransition,
  INTERVIEW_PREVIEW_TRANSITIONS,
  INTERVIEW_PREVIEW_VERSION,
  type InterviewPreviewInput,
  type InterviewPreviewStatus,
} from "./interview-preview";

const NOW = new Date("2026-07-17T00:00:00.000Z");

function input(overrides: Partial<InterviewPreviewInput> = {}): InterviewPreviewInput {
  return {
    candidateId: "cand-1",
    jobOrderId: "job-1",
    proposedWindows: [{ start: "2026-07-20T15:00:00.000Z", end: "2026-07-20T15:30:00.000Z" }],
    durationMinutes: 30,
    timezone: "America/Chicago",
    modality: "PHONE",
    locationOrLink: null,
    participants: [{ role: "recruiter", name: "Recruiter One" }],
    restrictions: [],
    ...overrides,
  };
}

test("NEEDS_AVAILABILITY when there are no proposed windows", () => {
  const result = buildInterviewPreview(input({ proposedWindows: [] }), NOW);
  assert.equal(result.status, "NEEDS_AVAILABILITY");
  assert.ok(result.missingInformation.includes("proposedWindows"));
});

test("DRAFT when windows exist but required info is missing (e.g. VIDEO without a link)", () => {
  const result = buildInterviewPreview(input({ modality: "VIDEO", locationOrLink: null }), NOW);
  assert.equal(result.status, "DRAFT");
  assert.ok(result.missingInformation.includes("locationOrLink"));
});

test("PHONE modality never requires locationOrLink", () => {
  const result = buildInterviewPreview(input({ modality: "PHONE", locationOrLink: null }), NOW);
  assert.ok(!result.missingInformation.includes("locationOrLink"));
});

test("READY_FOR_APPROVAL when everything is complete and there are no conflicts", () => {
  const result = buildInterviewPreview(input(), NOW);
  assert.equal(result.status, "READY_FOR_APPROVAL");
  assert.deepEqual(result.missingInformation, []);
  assert.deepEqual(result.conflicts, []);
});

test("DRAFT when a proposed window overlaps an existing preview window (conflict)", () => {
  const result = buildInterviewPreview(
    input({
      existingWindows: [{ interviewPreviewId: "other-1", start: "2026-07-20T15:15:00.000Z", end: "2026-07-20T15:45:00.000Z" }],
    }),
    NOW,
  );
  assert.equal(result.status, "DRAFT");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.withInterviewPreviewId, "other-1");
});

test("no conflict when proposed and existing windows do not overlap", () => {
  const result = buildInterviewPreview(
    input({
      existingWindows: [{ interviewPreviewId: "other-1", start: "2026-07-21T15:00:00.000Z", end: "2026-07-21T15:30:00.000Z" }],
    }),
    NOW,
  );
  assert.deepEqual(result.conflicts, []);
});

test("availabilityConfirmed is always false -- never presented as real without a calendar integration", () => {
  const result = buildInterviewPreview(input(), NOW);
  assert.equal(result.availabilityConfirmed, false);
});

test("participants and restrictions pass through unchanged (never invented)", () => {
  const participants = [{ role: "recruiter", name: "Ana" }, { role: "candidate", name: "Jamie" }];
  const restrictions = ["Candidate available only after 3pm CT"];
  const result = buildInterviewPreview(input({ participants, restrictions }), NOW);
  assert.deepEqual(result.participants, participants);
  assert.deepEqual(result.restrictions, restrictions);
});

test("is deterministic: same input twice produces an identical result", () => {
  const i = input();
  assert.deepEqual(buildInterviewPreview(i, NOW), buildInterviewPreview(i, NOW));
});

test("rulesVersion and calculatedAt are always present", () => {
  const result = buildInterviewPreview(input(), NOW);
  assert.equal(result.rulesVersion, INTERVIEW_PREVIEW_VERSION);
  assert.equal(result.calculatedAt, NOW.toISOString());
});

test("computeInterviewPreviewStatus: missing duration/timezone/participants forces DRAFT even with windows present", () => {
  assert.equal(computeInterviewPreviewStatus(["durationMinutes"], []), "DRAFT");
  assert.equal(computeInterviewPreviewStatus(["timezone"], []), "DRAFT");
  assert.equal(computeInterviewPreviewStatus(["participants"], []), "DRAFT");
});

test("isValidInterviewPreviewTransition: same-state is always valid (idempotent)", () => {
  const states: InterviewPreviewStatus[] = ["DRAFT", "NEEDS_AVAILABILITY", "READY_FOR_APPROVAL", "APPROVED_FOR_SEND", "CANCELLED"];
  for (const s of states) assert.equal(isValidInterviewPreviewTransition(s, s), true);
});

test("isValidInterviewPreviewTransition: APPROVED_FOR_SEND can only be reached from READY_FOR_APPROVAL", () => {
  assert.equal(isValidInterviewPreviewTransition("READY_FOR_APPROVAL", "APPROVED_FOR_SEND"), true);
  assert.equal(isValidInterviewPreviewTransition("DRAFT", "APPROVED_FOR_SEND"), false);
  assert.equal(isValidInterviewPreviewTransition("NEEDS_AVAILABILITY", "APPROVED_FOR_SEND"), false);
});

test("isValidInterviewPreviewTransition: CANCELLED is reachable from every non-terminal state and can reopen to DRAFT", () => {
  const states: InterviewPreviewStatus[] = ["DRAFT", "NEEDS_AVAILABILITY", "READY_FOR_APPROVAL", "APPROVED_FOR_SEND"];
  for (const s of states) assert.equal(isValidInterviewPreviewTransition(s, "CANCELLED"), true);
  assert.equal(isValidInterviewPreviewTransition("CANCELLED", "DRAFT"), true);
});

test("isValidInterviewPreviewTransition: CANCELLED cannot jump directly to APPROVED_FOR_SEND", () => {
  assert.equal(isValidInterviewPreviewTransition("CANCELLED", "APPROVED_FOR_SEND"), false);
});

test("INTERVIEW_PREVIEW_TRANSITIONS never permanently strands CANCELLED", () => {
  assert.ok(INTERVIEW_PREVIEW_TRANSITIONS.CANCELLED.length > 0);
});
