import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreeningPlan, ALLOWED_DISQUALIFIERS, SCREENING_PLAN_VERSION, type ScreeningPlanInput } from "./screening-plan";
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

function input(overrides: Partial<ScreeningPlanInput> = {}): ScreeningPlanInput {
  return {
    candidateId: "cand-1",
    jobOrderId: "job-1",
    categoryName: "Forklift Operator",
    qualification: qualification(),
    qualificationStatus: "QUALIFIED",
    ...overrides,
  };
}

test("always includes the 3 baseline questions (availability, experience, compliance)", () => {
  const plan = buildScreeningPlan(input(), NOW);
  const ids = plan.questions.map((q) => q.id);
  assert.ok(ids.includes("availability_start_date"));
  assert.ok(ids.includes("role_experience"));
  assert.ok(ids.includes("compliance_acknowledgment"));
  assert.equal(plan.questions.length, 3, "no conditional questions should appear when there are no gaps");
});

test("adds a document_readiness question when documents are missing or expired", () => {
  const missing = buildScreeningPlan(input({ qualification: qualification({ missingDocuments: ["i9"] }) }), NOW);
  assert.ok(missing.questions.some((q) => q.id === "document_readiness"));

  const expired = buildScreeningPlan(input({ qualification: qualification({ expiredDocuments: ["forklift_cert"] }) }), NOW);
  assert.ok(expired.questions.some((q) => q.id === "document_readiness"));
});

test("adds an experience_gap_probe question when experienceGap is true", () => {
  const plan = buildScreeningPlan(input({ qualification: qualification({ experienceGap: true }) }), NOW);
  assert.ok(plan.questions.some((q) => q.id === "experience_gap_probe"));
});

test("adds a language_verification question when languageGaps is non-empty", () => {
  const plan = buildScreeningPlan(input({ qualification: qualification({ languageGaps: ["fr"] }) }), NOW);
  assert.ok(plan.questions.some((q) => q.id === "language_verification"));
});

test("every question has a non-empty rationale and expectedEvidence (never a bare question with no justification)", () => {
  const plan = buildScreeningPlan(
    input({ qualification: qualification({ missingDocuments: ["i9"], experienceGap: true, languageGaps: ["fr"] }) }),
    NOW,
  );
  for (const q of plan.questions) {
    assert.ok(q.rationale.length > 0);
    assert.ok(q.expectedEvidence.length > 0);
  }
});

test("manualReviewFlags: NEEDS_REVIEW and NOT_QUALIFIED are flagged, QUALIFIED/POSSIBLY_QUALIFIED are not", () => {
  assert.ok(buildScreeningPlan(input({ qualificationStatus: "NEEDS_REVIEW" }), NOW).manualReviewFlags.length > 0);
  assert.ok(buildScreeningPlan(input({ qualificationStatus: "NOT_QUALIFIED" }), NOW).manualReviewFlags.length > 0);
  assert.equal(buildScreeningPlan(input({ qualificationStatus: "QUALIFIED" }), NOW).manualReviewFlags.length, 0);
  assert.equal(buildScreeningPlan(input({ qualificationStatus: "POSSIBLY_QUALIFIED" }), NOW).manualReviewFlags.length, 0);
});

test("missingInformation reflects missing/expired documents, empty when none", () => {
  const clean = buildScreeningPlan(input(), NOW);
  assert.deepEqual(clean.missingInformation, []);

  const withGaps = buildScreeningPlan(
    input({ qualification: qualification({ missingDocuments: ["i9"], expiredDocuments: ["forklift_cert"] }) }),
    NOW,
  );
  assert.equal(withGaps.missingInformation.length, 2);
});

test("riskFlags surface hard disqualifiers, experience gap, and language gaps -- empty when none", () => {
  const clean = buildScreeningPlan(input(), NOW);
  assert.deepEqual(clean.riskFlags, []);

  const risky = buildScreeningPlan(
    input({ qualification: qualification({ hardDisqualifiers: ["category_mismatch"], experienceGap: true, languageGaps: ["fr"] }) }),
    NOW,
  );
  assert.equal(risky.riskFlags.length, 3);
});

test("allowedDisqualifiers is always the same fixed whitelist, never derived from candidate data", () => {
  const a = buildScreeningPlan(input(), NOW);
  const b = buildScreeningPlan(input({ qualificationStatus: "NOT_QUALIFIED", qualification: qualification({ hardDisqualifiers: ["category_mismatch"] }) }), NOW);
  assert.deepEqual(a.allowedDisqualifiers, [...ALLOWED_DISQUALIFIERS]);
  assert.deepEqual(a.allowedDisqualifiers, b.allowedDisqualifiers);
});

test("is deterministic: same input twice produces an identical plan", () => {
  const i = input({ qualification: qualification({ missingDocuments: ["i9"], experienceGap: true }) });
  assert.deepEqual(buildScreeningPlan(i, NOW), buildScreeningPlan(i, NOW));
});

test("rulesVersion and calculatedAt are always present", () => {
  const plan = buildScreeningPlan(input(), NOW);
  assert.equal(plan.rulesVersion, SCREENING_PLAN_VERSION);
  assert.equal(plan.calculatedAt, NOW.toISOString());
});

test("fairness: no generated question text references a protected attribute, across every gap combination", () => {
  const forbidden = [
    "race",
    "raza",
    "gender",
    "género",
    "genero",
    "sex",
    "sexo",
    "age",
    "edad",
    "religio",
    "nationality",
    "nacionalidad",
    "disab",
    "discapacid",
    "pregnan",
    "embaraz",
    "marital",
    "estado civil",
    "national origin",
    "origen nacional",
    "criminal",
    "antecedentes penales",
    "immigration",
    "estatus migratorio",
    "citizenship",
    "ciudadanía",
    "ciudadania",
  ];

  const combos: ScreeningPlanInput[] = [
    input(),
    input({ qualification: qualification({ missingDocuments: ["i9"] }) }),
    input({ qualification: qualification({ expiredDocuments: ["forklift_cert"] }) }),
    input({ qualification: qualification({ experienceGap: true }) }),
    input({ qualification: qualification({ languageGaps: ["fr", "de"] }) }),
    input({ qualificationStatus: "NOT_QUALIFIED", qualification: qualification({ hardDisqualifiers: ["category_mismatch"] }) }),
    input({ qualificationStatus: "NEEDS_REVIEW" }),
  ];

  for (const i of combos) {
    const plan = buildScreeningPlan(i, NOW);
    for (const q of plan.questions) {
      const text = `${q.question} ${q.rationale} ${q.expectedEvidence}`.toLowerCase();
      for (const term of forbidden) {
        assert.ok(!text.includes(term), `question "${q.id}" must not reference protected attribute "${term}" (text: "${text}")`);
      }
    }
  }
});

test("fairness: allowedDisqualifiers never contains a protected-attribute term", () => {
  const forbidden = ["race", "gender", "sex", "age", "religion", "nationality", "disability", "pregnancy", "marital", "criminal", "immigration", "citizenship"];
  for (const reason of ALLOWED_DISQUALIFIERS) {
    const lower = reason.toLowerCase();
    for (const term of forbidden) {
      assert.ok(!lower.includes(term), `allowedDisqualifiers entry "${reason}" must not reference "${term}"`);
    }
  }
});
