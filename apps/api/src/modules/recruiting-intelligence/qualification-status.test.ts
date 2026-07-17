import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveQualificationStatus, QUALIFICATION_STATUS_VERSION } from "./qualification-status";
import type { QualificationEvaluationResult } from "./qualification-rules";

function result(overrides: Partial<QualificationEvaluationResult> = {}): QualificationEvaluationResult {
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

test("QUALIFIED: no hard disqualifiers, no soft gaps", () => {
  const derived = deriveQualificationStatus(result());
  assert.equal(derived.status, "QUALIFIED");
});

test("POSSIBLY_QUALIFIED: no hard disqualifiers, but experienceGap present", () => {
  const derived = deriveQualificationStatus(result({ experienceGap: true }));
  assert.equal(derived.status, "POSSIBLY_QUALIFIED");
});

test("POSSIBLY_QUALIFIED: no hard disqualifiers, but languageGaps present", () => {
  const derived = deriveQualificationStatus(result({ languageGaps: ["en"] }));
  assert.equal(derived.status, "POSSIBLY_QUALIFIED");
});

test("NEEDS_REVIEW: the only disqualifier is a missing required document", () => {
  const derived = deriveQualificationStatus(
    result({ hardDisqualifiers: ["missing_required_document:drivers_license"], missingDocuments: ["drivers_license"] }),
  );
  assert.equal(derived.status, "NEEDS_REVIEW");
});

test("NEEDS_REVIEW: multiple missing documents, still no hard non-recoverable disqualifier", () => {
  const derived = deriveQualificationStatus(
    result({
      hardDisqualifiers: ["missing_required_document:drivers_license", "missing_required_document:i9"],
      missingDocuments: ["drivers_license", "i9"],
    }),
  );
  assert.equal(derived.status, "NEEDS_REVIEW");
});

test("NOT_QUALIFIED: candidate_status_ineligible is present", () => {
  const derived = deriveQualificationStatus(result({ hardDisqualifiers: ["candidate_status_ineligible"] }));
  assert.equal(derived.status, "NOT_QUALIFIED");
});

test("NOT_QUALIFIED: category_mismatch is present", () => {
  const derived = deriveQualificationStatus(result({ hardDisqualifiers: ["category_mismatch"] }));
  assert.equal(derived.status, "NOT_QUALIFIED");
});

test("NOT_QUALIFIED: an expired document is present", () => {
  const derived = deriveQualificationStatus(
    result({ hardDisqualifiers: ["document_expired:drivers_license"], expiredDocuments: ["drivers_license"] }),
  );
  assert.equal(derived.status, "NOT_QUALIFIED");
});

test("NOT_QUALIFIED wins even when a missing-document disqualifier is also present", () => {
  const derived = deriveQualificationStatus(
    result({ hardDisqualifiers: ["category_mismatch", "missing_required_document:i9"] }),
  );
  assert.equal(derived.status, "NOT_QUALIFIED");
});

test("passes through reasons, hardDisqualifiers, and rulesVersion unchanged", () => {
  const input = result({
    hardDisqualifiers: ["category_mismatch"],
    reasons: ["El candidato no está asociado a la categoría de puesto requerida."],
    rulesVersion: 7,
  });
  const derived = deriveQualificationStatus(input);
  assert.deepEqual(derived.reasons, input.reasons);
  assert.deepEqual(derived.hardDisqualifiers, input.hardDisqualifiers);
  assert.equal(derived.rulesVersion, 7);
});

test("QUALIFICATION_STATUS_VERSION is a stable exported constant", () => {
  assert.equal(typeof QUALIFICATION_STATUS_VERSION, "number");
});
