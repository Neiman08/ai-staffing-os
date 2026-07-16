import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreWorkerForJobOrder,
  computeDisqualifiers,
  scoreRequiredDocuments,
  scoreExperience,
  scoreLocation,
  scorePayRate,
  scoreAssignmentHistory,
  scoreLanguages,
  scoreDataRecency,
  FACTOR_WEIGHTS,
  type WorkerScoringInput,
} from "./scoring";
import { workerMatchResultSchema } from "@ai-staffing-os/shared";

const d = (s: string) => new Date(s);

function baseInput(overrides: Partial<WorkerScoringInput> = {}): WorkerScoringInput {
  return {
    workerId: "worker-x",
    candidateId: "candidate-x",
    displayName: "Test Worker",
    workerStatus: "AVAILABLE",
    complianceStatus: "COMPLIANT",
    defaultPayRate: 21,
    candidateCategoryIds: ["category-forklift-operator"],
    yearsExperience: 10,
    city: "Chicago",
    state: "IL",
    languages: ["en", "es"],
    candidateUpdatedAt: d("2026-07-01"),
    documents: [
      { documentTypeKey: "forklift_cert", status: "VERIFIED" },
      { documentTypeKey: "drug_test", status: "VERIFIED" },
    ],
    assignmentHistory: [{ status: "COMPLETED", categoryId: "category-forklift-operator", companyId: "company-1" }],
    availabilityStatus: "AVAILABLE",
    jobOrder: {
      categoryId: "category-forklift-operator",
      companyId: "company-1",
      requirements: ["forklift_cert", "drug_test"],
      payRate: 21,
      location: { city: "Chicago", state: "IL" },
    },
    now: d("2026-07-15"),
    ...overrides,
  };
}

// ---------- Filtros duros (elegibilidad) ----------

test("candidato perfecto: ELIGIBLE, score alto, sin disqualifiers, sin gaps mayores", () => {
  const result = scoreWorkerForJobOrder(baseInput());
  assert.equal(result.eligibility, "ELIGIBLE");
  assert.deepEqual(result.disqualifiers, []);
  assert.ok(result.deterministicScore > 90, `esperaba score alto, obtuvo ${result.deterministicScore}`);
});

test("categoría incompatible → disqualifier category_mismatch, INELIGIBLE, score 0", () => {
  const result = scoreWorkerForJobOrder(baseInput({ candidateCategoryIds: ["category-warehouse-worker"] }));
  assert.equal(result.eligibility, "INELIGIBLE");
  assert.ok(result.disqualifiers.includes("category_mismatch"));
  assert.equal(result.deterministicScore, 0);
});

test("Worker TERMINATED → disqualifier worker_terminated", () => {
  const result = scoreWorkerForJobOrder(baseInput({ workerStatus: "TERMINATED" }));
  assert.ok(result.disqualifiers.includes("worker_terminated"));
  assert.equal(result.eligibility, "INELIGIBLE");
});

test("Worker ON_LEAVE → disqualifier worker_on_leave", () => {
  const result = scoreWorkerForJobOrder(baseInput({ workerStatus: "ON_LEAVE" }));
  assert.ok(result.disqualifiers.includes("worker_on_leave"));
});

test("compliance PENDING → disqualifier compliance_not_cleared", () => {
  const result = scoreWorkerForJobOrder(baseInput({ complianceStatus: "PENDING" }));
  assert.ok(result.disqualifiers.includes("compliance_not_cleared"));
  assert.equal(result.eligibility, "INELIGIBLE");
});

test("compliance BLOCKED → disqualifier compliance_not_cleared", () => {
  const result = scoreWorkerForJobOrder(baseInput({ complianceStatus: "BLOCKED" }));
  assert.ok(result.disqualifiers.includes("compliance_not_cleared"));
});

test("compliance COMPLIANT → sin ese disqualifier", () => {
  const result = scoreWorkerForJobOrder(baseInput({ complianceStatus: "COMPLIANT" }));
  assert.ok(!result.disqualifiers.includes("compliance_not_cleared"));
});

test("disponibilidad DATE_CONFLICT → disqualifier date_overlap, incluso si Worker.status=AVAILABLE", () => {
  const result = scoreWorkerForJobOrder(baseInput({ workerStatus: "AVAILABLE", availabilityStatus: "DATE_CONFLICT" }));
  assert.ok(result.disqualifiers.includes("date_overlap"));
  assert.equal(result.eligibility, "INELIGIBLE");
});

test("disponibilidad WORKER_UNAVAILABLE con Worker.status ASSIGNED sin DATE_CONFLICT explícito no agrega date_overlap por sí solo", () => {
  // WORKER_UNAVAILABLE en F6.2 solo ocurre para TERMINATED/ON_LEAVE, que
  // ya tienen su propio disqualifier — este caso confirma que
  // computeDisqualifiers no duplica lógica de disponibilidad más allá
  // de DATE_CONFLICT.
  const result = computeDisqualifiers(baseInput({ workerStatus: "ASSIGNED", availabilityStatus: "AVAILABLE" }));
  assert.ok(!result.includes("date_overlap"));
});

test("disponibilidad AVAILABLE sin otros disqualifiers → elegible", () => {
  const result = scoreWorkerForJobOrder(baseInput({ workerStatus: "ASSIGNED", availabilityStatus: "AVAILABLE" }));
  assert.equal(result.eligibility, "ELIGIBLE");
});

test("Worker INELIGIBLE nunca puede tener un WorkerMatchResult válido con eligibility=ELIGIBLE (invariante de contrato)", () => {
  const result = scoreWorkerForJobOrder(baseInput({ workerStatus: "TERMINATED" }));
  const parsed = workerMatchResultSchema.safeParse({
    workerId: "w1",
    candidateId: "c1",
    displayName: "X",
    workerStatus: "TERMINATED",
    complianceStatus: "COMPLIANT",
    availabilityStatus: "WORKER_UNAVAILABLE",
    eligibility: "ELIGIBLE", // deliberadamente inconsistente con disqualifiers no vacíos
    deterministicScore: result.deterministicScore,
    llmAdjustment: null,
    finalScore: result.deterministicScore,
    rationale: "x",
    strengths: [],
    gaps: result.gaps,
    disqualifiers: result.disqualifiers,
    requiredDocumentsMissing: [],
    categoryAssessment: result.categoryAssessment,
    experienceAssessment: result.experienceAssessment,
    locationAssessment: result.locationAssessment,
    payRateAssessment: result.payRateAssessment,
    complianceAssessment: result.complianceAssessment,
    availabilityAssessment: result.availabilityAssessment,
    factors: result.factors,
  });
  assert.equal(parsed.success, false, "un resultado con disqualifiers no vacíos y eligibility=ELIGIBLE debe ser rechazado por el contrato");
});

// ---------- Factor: documentos requeridos ----------

test("documentos: todos verificados → score máximo, sin faltantes", () => {
  const { factor, missing } = scoreRequiredDocuments(baseInput());
  assert.equal(factor.score, FACTOR_WEIGHTS.requiredDocuments);
  assert.deepEqual(missing, []);
});

test("documentos: uno faltante de dos → score proporcional (50%)", () => {
  const { factor, missing } = scoreRequiredDocuments(
    baseInput({ documents: [{ documentTypeKey: "forklift_cert", status: "VERIFIED" }] }),
  );
  assert.equal(factor.score, FACTOR_WEIGHTS.requiredDocuments * 0.5);
  assert.deepEqual(missing, ["drug_test"]);
});

test("documentos: PENDING_REVIEW/REJECTED/EXPIRED cuentan como faltante (nunca parcialmente válido)", () => {
  for (const status of ["PENDING_REVIEW", "REJECTED", "EXPIRED"]) {
    const { missing } = scoreRequiredDocuments(
      baseInput({ documents: [{ documentTypeKey: "forklift_cert", status }, { documentTypeKey: "drug_test", status: "VERIFIED" }] }),
    );
    assert.deepEqual(missing, ["forklift_cert"], `status ${status} debería contar como faltante`);
  }
});

test("documentos: sin requisitos → score máximo automático", () => {
  const { factor, missing } = scoreRequiredDocuments(baseInput({ jobOrder: { ...baseInput().jobOrder, requirements: [] } }));
  assert.equal(factor.score, FACTOR_WEIGHTS.requiredDocuments);
  assert.deepEqual(missing, []);
});

// ---------- Factor: experiencia ----------

test("experiencia alta (>= 10 años) → score máximo", () => {
  const factor = scoreExperience(baseInput({ yearsExperience: 12 }));
  assert.equal(factor.score, FACTOR_WEIGHTS.experience);
});

test("experiencia baja (2 de 10 años) → score proporcional", () => {
  const factor = scoreExperience(baseInput({ yearsExperience: 2 }));
  assert.equal(factor.score, FACTOR_WEIGHTS.experience * 0.2);
});

test("experiencia desconocida (null) → score 0, no se inventa un valor", () => {
  const factor = scoreExperience(baseInput({ yearsExperience: null }));
  assert.equal(factor.score, 0);
  assert.match(factor.evidence[0]!, /desconoc/i);
});

// ---------- Factor: ubicación ----------

test("ubicación: misma ciudad → score 15", () => {
  const factor = scoreLocation(baseInput({ city: "Chicago", state: "IL", jobOrder: { ...baseInput().jobOrder, location: { city: "Chicago", state: "IL" } } }));
  assert.equal(factor.score, 15);
});

test("ubicación: mismo estado, ciudad distinta → score 8", () => {
  const factor = scoreLocation(baseInput({ city: "Aurora", state: "IL", jobOrder: { ...baseInput().jobOrder, location: { city: "Chicago", state: "IL" } } }));
  assert.equal(factor.score, 8);
});

test("ubicación: estado distinto → score 0", () => {
  const factor = scoreLocation(baseInput({ city: "Gary", state: "IN", jobOrder: { ...baseInput().jobOrder, location: { city: "Chicago", state: "IL" } } }));
  assert.equal(factor.score, 0);
});

test("ubicación: sin datos de ninguno de los dos lados → score 0, no se asume compatibilidad", () => {
  const factor = scoreLocation(baseInput({ city: null, state: null, jobOrder: { ...baseInput().jobOrder, location: null } }));
  assert.equal(factor.score, 0);
});

// ---------- Factor: pay rate ----------

test("pay rate: exactamente igual → score máximo", () => {
  const factor = scorePayRate(baseInput({ defaultPayRate: 21, jobOrder: { ...baseInput().jobOrder, payRate: 21 } }));
  assert.equal(factor.score, FACTOR_WEIGHTS.payRate);
});

test("pay rate: worker pide más → penaliza", () => {
  const factor = scorePayRate(baseInput({ defaultPayRate: 30, jobOrder: { ...baseInput().jobOrder, payRate: 21 } }));
  assert.ok(factor.score < FACTOR_WEIGHTS.payRate);
});

test("pay rate: worker pide menos → también penaliza (evita fricción en cualquier dirección)", () => {
  const factorLower = scorePayRate(baseInput({ defaultPayRate: 10, jobOrder: { ...baseInput().jobOrder, payRate: 21 } }));
  const factorHigher = scorePayRate(baseInput({ defaultPayRate: 32, jobOrder: { ...baseInput().jobOrder, payRate: 21 } }));
  assert.ok(factorLower.score < FACTOR_WEIGHTS.payRate);
  assert.ok(factorHigher.score < FACTOR_WEIGHTS.payRate);
});

test("pay rate: diferencia extrema → score acotado a 0, nunca negativo", () => {
  const factor = scorePayRate(baseInput({ defaultPayRate: 1000, jobOrder: { ...baseInput().jobOrder, payRate: 21 } }));
  assert.equal(factor.score, 0);
});

// ---------- Factor: historial de assignments ----------

test("historial: Assignment COMPLETED en misma categoría → bonus completo", () => {
  const factor = scoreAssignmentHistory(baseInput());
  assert.equal(factor.score, FACTOR_WEIGHTS.assignmentHistory);
});

test("historial: Assignment TERMINATED no cuenta (solo COMPLETED)", () => {
  const factor = scoreAssignmentHistory(
    baseInput({ assignmentHistory: [{ status: "TERMINATED", categoryId: "category-forklift-operator", companyId: "company-1" }] }),
  );
  assert.equal(factor.score, 0);
});

test("historial: sin ninguna Assignment previa → 0", () => {
  const factor = scoreAssignmentHistory(baseInput({ assignmentHistory: [] }));
  assert.equal(factor.score, 0);
});

// ---------- Factor: idiomas ----------

test("idiomas: multilingüe → +5", () => {
  const factor = scoreLanguages(baseInput({ languages: ["en", "es"] }));
  assert.equal(factor.score, FACTOR_WEIGHTS.languages);
});

test("idiomas: monolingüe (o el Job Order no requiere idioma) → 0", () => {
  const factor = scoreLanguages(baseInput({ languages: ["en"] }));
  assert.equal(factor.score, 0);
});

// ---------- Factor: recencia de datos ----------

test("recencia: actualizado hace <= 90 días → score máximo", () => {
  const factor = scoreDataRecency(baseInput({ candidateUpdatedAt: d("2026-07-01"), now: d("2026-07-15") }));
  assert.equal(factor.score, FACTOR_WEIGHTS.dataRecency);
});

test("recencia: actualizado hace >= 365 días → 0", () => {
  const factor = scoreDataRecency(baseInput({ candidateUpdatedAt: d("2025-01-01"), now: d("2026-07-15") }));
  assert.equal(factor.score, 0);
});

test("recencia: punto intermedio → escala decreciente estricta entre 90 y 365 días", () => {
  const factor = scoreDataRecency(baseInput({ candidateUpdatedAt: d("2026-04-01"), now: d("2026-07-15") }));
  assert.ok(factor.score > 0 && factor.score < FACTOR_WEIGHTS.dataRecency);
});

// ---------- Score total: 0, 100, redondeos ----------

test("score 0: worker con todos los factores en el peor caso posible (elegible pero sin ninguna señal positiva)", () => {
  const result = scoreWorkerForJobOrder(
    baseInput({
      yearsExperience: 0,
      city: null,
      state: null,
      jobOrder: { ...baseInput().jobOrder, location: null, payRate: 21 },
      defaultPayRate: 1000,
      assignmentHistory: [],
      languages: ["en"],
      candidateUpdatedAt: d("2020-01-01"),
      documents: [],
    }),
  );
  assert.equal(result.eligibility, "ELIGIBLE");
  assert.equal(result.deterministicScore, 0);
});

test("score 100: worker con todos los factores en el máximo", () => {
  const result = scoreWorkerForJobOrder(
    baseInput({
      yearsExperience: 15,
      city: "Chicago",
      state: "IL",
      defaultPayRate: 21,
      languages: ["en", "es"],
      candidateUpdatedAt: d("2026-07-14"),
      documents: [
        { documentTypeKey: "forklift_cert", status: "VERIFIED" },
        { documentTypeKey: "drug_test", status: "VERIFIED" },
      ],
      assignmentHistory: [{ status: "COMPLETED", categoryId: "category-forklift-operator", companyId: "company-1" }],
    }),
  );
  assert.equal(result.deterministicScore, 100);
});

test("invariante: deterministicScore siempre igual a la suma exacta de los 7 factores", () => {
  const cases: Partial<WorkerScoringInput>[] = [
    {},
    { yearsExperience: 3 },
    { defaultPayRate: 25 },
    { documents: [] },
    { assignmentHistory: [] },
  ];
  for (const c of cases) {
    const result = scoreWorkerForJobOrder(baseInput(c));
    if (result.eligibility === "INELIGIBLE") continue;
    const sum = Object.values(result.factors).reduce((acc, f) => acc + f.score, 0);
    assert.ok(Math.abs(sum - result.deterministicScore) < 0.001);
  }
});

test("el resultado siempre es válido contra el contrato Zod completo (WorkerMatchResult), envuelto con los campos restantes", () => {
  const result = scoreWorkerForJobOrder(baseInput());
  const parsed = workerMatchResultSchema.safeParse({
    workerId: "w1",
    candidateId: "c1",
    displayName: "Test Worker",
    workerStatus: "AVAILABLE",
    complianceStatus: "COMPLIANT",
    availabilityStatus: "AVAILABLE",
    eligibility: result.eligibility,
    deterministicScore: result.deterministicScore,
    llmAdjustment: null,
    finalScore: result.deterministicScore,
    rationale: "test",
    strengths: result.strengths,
    gaps: result.gaps,
    disqualifiers: result.disqualifiers,
    requiredDocumentsMissing: result.requiredDocumentsMissing,
    categoryAssessment: result.categoryAssessment,
    experienceAssessment: result.experienceAssessment,
    locationAssessment: result.locationAssessment,
    payRateAssessment: result.payRateAssessment,
    complianceAssessment: result.complianceAssessment,
    availabilityAssessment: result.availabilityAssessment,
    factors: result.factors,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success === false ? parsed.error.issues : null));
});

test("ausencia de atributos protegidos: WorkerScoringInput no tiene ningún campo de raza/sexo/edad/religión/nacionalidad/discapacidad/embarazo/datos médicos", () => {
  const input = baseInput();
  const forbidden = ["race", "gender", "sex", "age", "religion", "nationality", "disability", "pregnant", "medical", "ethnicity", "dateOfBirth", "ssn"];
  for (const key of forbidden) {
    assert.equal(key in input, false, `WorkerScoringInput no debe tener el campo "${key}"`);
  }
});

test("mismo input produce siempre el mismo resultado (determinismo estricto)", () => {
  const input = baseInput();
  const r1 = scoreWorkerForJobOrder(input);
  const r2 = scoreWorkerForJobOrder(input);
  assert.deepEqual(r1, r2);
});
