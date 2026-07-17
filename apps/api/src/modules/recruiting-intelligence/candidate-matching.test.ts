import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCandidateMatch,
  computeCandidateMatching,
  CANDIDATE_MATCHING_VERSION,
  MATCHING_FACTOR_WEIGHTS,
  type CandidateForMatching,
  type JobForMatching,
} from "./candidate-matching";
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

function candidate(overrides: Partial<CandidateForMatching> = {}): CandidateForMatching {
  return {
    candidateId: "cand-1",
    qualification: qualification(),
    qualificationStatus: "QUALIFIED",
    yearsExperience: 5,
    state: "IL",
    languages: ["en", "es"],
    candidateUpdatedAt: NOW,
    ...overrides,
  };
}

function job(overrides: Partial<JobForMatching> = {}): JobForMatching {
  return { jobOrderId: "job-1", state: "IL", requiredDocumentCount: 0, ...overrides };
}

test("MATCHING_FACTOR_WEIGHTS sum to exactly 100", () => {
  const total = Object.values(MATCHING_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test("NOT_QUALIFIED is never recommendable, gets score 0 and rank null, and is never scored partially", () => {
  const result = computeCandidateMatch(
    candidate({ qualificationStatus: "NOT_QUALIFIED", qualification: qualification({ hardDisqualifiers: ["category_mismatch"] }) }),
    job(),
    NOW,
  );
  assert.equal(result.recommendable, false);
  assert.equal(result.score, 0);
  assert.equal(result.normalizedScore, 0);
  assert.equal(result.rank, null);
  assert.deepEqual(result.softPreferences, []);
});

test("NEEDS_REVIEW is recommendable and marked with needsReview=true", () => {
  const result = computeCandidateMatch(candidate({ qualificationStatus: "NEEDS_REVIEW" }), job(), NOW);
  assert.equal(result.recommendable, true);
  assert.equal(result.needsReview, true);
});

test("POSSIBLY_QUALIFIED is recommendable, not flagged needsReview, and surfaces gaps as risks", () => {
  const result = computeCandidateMatch(
    candidate({ qualificationStatus: "POSSIBLY_QUALIFIED", qualification: qualification({ experienceGap: true }) }),
    job(),
    NOW,
  );
  assert.equal(result.recommendable, true);
  assert.equal(result.needsReview, false);
  assert.ok(result.risks.some((r) => r.includes("experiencia")));
});

test("QUALIFIED ranks normally with a full soft-preference breakdown", () => {
  const result = computeCandidateMatch(candidate({ yearsExperience: 10 }), job(), NOW);
  assert.equal(result.recommendable, true);
  assert.equal(result.softPreferences.length, 5);
  assert.equal(result.score, 100, "a candidate matching every soft factor perfectly should score 100/100");
});

test("documentReadiness: full score when the job has no required documents", () => {
  const result = computeCandidateMatch(candidate(), job({ requiredDocumentCount: 0 }), NOW);
  const factor = result.softPreferences.find((f) => f.key === "documentReadiness")!;
  assert.equal(factor.score, MATCHING_FACTOR_WEIGHTS.documentReadiness);
});

test("documentReadiness: partial credit proportional to missing/expired documents", () => {
  const result = computeCandidateMatch(
    candidate({ qualification: qualification({ missingDocuments: ["i9"] }) }),
    job({ requiredDocumentCount: 2 }),
    NOW,
  );
  const factor = result.softPreferences.find((f) => f.key === "documentReadiness")!;
  assert.equal(factor.score, MATCHING_FACTOR_WEIGHTS.documentReadiness * 0.5);
});

test("experience: null yearsExperience scores 0, never throws", () => {
  const result = computeCandidateMatch(candidate({ yearsExperience: null }), job(), NOW);
  const factor = result.softPreferences.find((f) => f.key === "experience")!;
  assert.equal(factor.score, 0);
});

test("location: same state as Job Order scores full, different state scores 0", () => {
  const same = computeCandidateMatch(candidate({ state: "IL" }), job({ state: "IL" }), NOW);
  const different = computeCandidateMatch(candidate({ state: "TX" }), job({ state: "IL" }), NOW);
  assert.equal(same.softPreferences.find((f) => f.key === "location")!.score, MATCHING_FACTOR_WEIGHTS.location);
  assert.equal(different.softPreferences.find((f) => f.key === "location")!.score, 0);
});

test("languages: multilingual scores full, monolingual scores 0", () => {
  const multi = computeCandidateMatch(candidate({ languages: ["en", "es"] }), job(), NOW);
  const mono = computeCandidateMatch(candidate({ languages: ["en"] }), job(), NOW);
  assert.equal(multi.softPreferences.find((f) => f.key === "languages")!.score, MATCHING_FACTOR_WEIGHTS.languages);
  assert.equal(mono.softPreferences.find((f) => f.key === "languages")!.score, 0);
});

test("dataRecency: recently updated profile scores full, stale profile (>365 days) scores 0", () => {
  const fresh = computeCandidateMatch(candidate({ candidateUpdatedAt: NOW }), job(), NOW);
  const stale = computeCandidateMatch(
    candidate({ candidateUpdatedAt: new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000) }),
    job(),
    NOW,
  );
  assert.equal(fresh.softPreferences.find((f) => f.key === "dataRecency")!.score, MATCHING_FACTOR_WEIGHTS.dataRecency);
  assert.equal(stale.softPreferences.find((f) => f.key === "dataRecency")!.score, 0);
});

test("missingData/confidence: no missing fields -> HIGH; 3+ missing -> LOW", () => {
  const complete = computeCandidateMatch(candidate({ yearsExperience: 5, state: "IL", languages: ["en"] }), job(), NOW);
  assert.deepEqual(complete.missingData, []);
  assert.equal(complete.confidence, "HIGH");

  const sparse = computeCandidateMatch(candidate({ yearsExperience: null, state: null, languages: [] }), job(), NOW);
  assert.equal(sparse.missingData.length, 3);
  assert.equal(sparse.confidence, "LOW");
});

test("hardConstraints pass through qualification.hardDisqualifiers unchanged, never re-derived", () => {
  const result = computeCandidateMatch(
    candidate({ qualificationStatus: "NEEDS_REVIEW", qualification: qualification({ hardDisqualifiers: ["missing_required_document:i9"] }) }),
    job(),
    NOW,
  );
  assert.deepEqual(result.hardConstraints, ["missing_required_document:i9"]);
});

test("evidence includes qualification reasons and per-factor evidence (auditable trail)", () => {
  const result = computeCandidateMatch(candidate(), job(), NOW);
  assert.ok(result.evidence.includes("El candidato cumple todos los requisitos verificables del Job Order."));
  assert.ok(result.evidence.length > 1);
});

test("rulesVersion and calculatedAt are always present", () => {
  const result = computeCandidateMatch(candidate(), job(), NOW);
  assert.equal(result.rulesVersion, CANDIDATE_MATCHING_VERSION);
  assert.equal(result.calculatedAt, NOW.toISOString());
});

test("computeCandidateMatching: NOT_QUALIFIED candidates are excluded, never appear in ranked, never get a rank", () => {
  const result = computeCandidateMatching(
    [
      candidate({ candidateId: "qualified-1" }),
      candidate({ candidateId: "not-qualified-1", qualificationStatus: "NOT_QUALIFIED", qualification: qualification({ hardDisqualifiers: ["category_mismatch"] }) }),
    ],
    job(),
    NOW,
  );
  assert.equal(result.ranked.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]!.candidateId, "not-qualified-1");
  assert.equal(result.excluded[0]!.rank, null);
});

test("computeCandidateMatching: ranked sorted by normalizedScore desc, tie-break by candidateId asc, ranks are 1-based sequential", () => {
  const result = computeCandidateMatching(
    [
      candidate({ candidateId: "b", yearsExperience: 2 }),
      candidate({ candidateId: "a", yearsExperience: 2 }), // same score as "b" -- tie
      candidate({ candidateId: "c", yearsExperience: 10 }), // higher score
    ],
    job(),
    NOW,
  );
  assert.deepEqual(result.ranked.map((r) => r.candidateId), ["c", "a", "b"]);
  assert.deepEqual(result.ranked.map((r) => r.rank), [1, 2, 3]);
});

test("computeCandidateMatching is deterministic: same input twice produces identical output", () => {
  const candidates = [candidate({ candidateId: "x" }), candidate({ candidateId: "y", yearsExperience: 3 })];
  const first = computeCandidateMatching(candidates, job(), NOW);
  const second = computeCandidateMatching(candidates, job(), NOW);
  assert.deepEqual(first, second);
});

test("no protected attribute field exists anywhere in the input/output shape (fairness)", () => {
  // Comparación exacta contra una allow-list -- una búsqueda de substring
  // (ej. "yearsExperience".includes("sex")) da falsos positivos, ver el
  // mismo hallazgo ya documentado en qualification-rules.test.ts (F8.2).
  const allowedCandidateKeys = ["candidateId", "qualification", "qualificationStatus", "yearsExperience", "state", "languages", "candidateUpdatedAt"];
  const allowedResultKeys = [
    "candidateId",
    "qualificationStatus",
    "recommendable",
    "needsReview",
    "hardConstraints",
    "softPreferences",
    "score",
    "normalizedScore",
    "rank",
    "explanation",
    "confidence",
    "missingData",
    "risks",
    "evidence",
    "rulesVersion",
    "calculatedAt",
  ];
  const result = computeCandidateMatch(candidate(), job(), NOW);
  assert.deepEqual(Object.keys(candidate()).sort(), [...allowedCandidateKeys].sort());
  assert.deepEqual(Object.keys(result).sort(), [...allowedResultKeys].sort());

  const forbidden = ["race", "gender", "age", "religion", "nationality", "disability", "pregnancy", "ethnicity", "birthdate", "immigration", "ssn"];
  for (const key of [...allowedCandidateKeys, ...allowedResultKeys]) {
    assert.ok(!forbidden.includes(key.toLowerCase()), `field "${key}" must not be a protected attribute`);
  }
});
