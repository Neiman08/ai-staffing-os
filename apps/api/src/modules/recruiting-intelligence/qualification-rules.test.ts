import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCandidateQualification, type QualificationEvaluationInput, type QualificationDocument } from "./qualification-rules";

function baseCandidate(overrides: Partial<QualificationEvaluationInput["candidate"]> = {}): QualificationEvaluationInput["candidate"] {
  return {
    candidateId: "candidate-1",
    status: "NEW",
    categoryIds: ["category-forklift-operator"],
    yearsExperience: 3,
    languages: ["English"],
    documents: [],
    ...overrides,
  };
}

function baseJob(overrides: Partial<QualificationEvaluationInput["job"]> = {}): QualificationEvaluationInput["job"] {
  return {
    categoryId: "category-forklift-operator",
    requiredDocumentTypeKeys: [],
    minYearsExperience: null,
    requiredLanguages: [],
    ...overrides,
  };
}

function verifiedDoc(key: string, expirationDate: string | null = null): QualificationDocument {
  return { documentTypeKey: key, status: "VERIFIED", expirationDate };
}

test("candidato que cumple categoria, sin requisitos extra -> sin disqualifiers, con fortalezas", () => {
  const result = evaluateCandidateQualification({ candidate: baseCandidate(), job: baseJob() });
  assert.deepEqual(result.hardDisqualifiers, []);
  assert.ok(result.strengths.includes("Categoría de puesto coincide."));
});

test("categoria no coincide -> category_mismatch, siempre un hard disqualifier", () => {
  const result = evaluateCandidateQualification({ candidate: baseCandidate({ categoryIds: ["category-electrician"] }), job: baseJob() });
  assert.ok(result.hardDisqualifiers.includes("category_mismatch"));
});

test("candidato REJECTED o INACTIVE siempre queda descalificado, sin importar el resto de la evidencia", () => {
  const rejected = evaluateCandidateQualification({ candidate: baseCandidate({ status: "REJECTED" }), job: baseJob() });
  assert.ok(rejected.hardDisqualifiers.includes("candidate_status_ineligible"));
  const inactive = evaluateCandidateQualification({ candidate: baseCandidate({ status: "INACTIVE" }), job: baseJob() });
  assert.ok(inactive.hardDisqualifiers.includes("candidate_status_ineligible"));
});

test("candidato NEW/SCREENING/QUALIFIED/PLACED nunca se descalifica solo por su status", () => {
  for (const status of ["NEW", "SCREENING", "QUALIFIED", "PLACED"]) {
    const result = evaluateCandidateQualification({ candidate: baseCandidate({ status }), job: baseJob() });
    assert.ok(!result.hardDisqualifiers.includes("candidate_status_ineligible"), status);
  }
});

test("documento requerido ausente -> missing_required_document, nunca inventa que existe", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ documents: [] }),
    job: baseJob({ requiredDocumentTypeKeys: ["forklift_cert"] }),
  });
  assert.ok(result.hardDisqualifiers.includes("missing_required_document:forklift_cert"));
  assert.ok(result.missingDocuments.includes("forklift_cert"));
});

test("documento requerido presente y verificado, sin vencimiento -> nunca descalifica", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ documents: [verifiedDoc("forklift_cert")] }),
    job: baseJob({ requiredDocumentTypeKeys: ["forklift_cert"] }),
  });
  assert.equal(result.hardDisqualifiers.length, 0);
  assert.ok(result.strengths.some((s) => s.includes("vigentes")));
});

test("documento requerido vencido -> document_expired, distinto de missing", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ documents: [verifiedDoc("forklift_cert", "2020-01-01")] }),
    job: baseJob({ requiredDocumentTypeKeys: ["forklift_cert"] }),
    now: "2026-07-17",
  });
  assert.ok(result.hardDisqualifiers.includes("document_expired:forklift_cert"));
  assert.ok(result.expiredDocuments.includes("forklift_cert"));
  assert.ok(!result.missingDocuments.includes("forklift_cert"));
});

test("documento PENDING_REVIEW o REJECTED nunca cuenta como valido -- solo VERIFIED y no vencido califica", () => {
  const pending = evaluateCandidateQualification({
    candidate: baseCandidate({ documents: [{ documentTypeKey: "forklift_cert", status: "PENDING_REVIEW", expirationDate: null }] }),
    job: baseJob({ requiredDocumentTypeKeys: ["forklift_cert"] }),
  });
  assert.ok(pending.hardDisqualifiers.includes("missing_required_document:forklift_cert"));
});

test("experiencia insuficiente -> experienceGap true, nunca un hard disqualifier (es un gap blando)", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ yearsExperience: 1 }),
    job: baseJob({ minYearsExperience: 3 }),
  });
  assert.equal(result.experienceGap, true);
  assert.equal(result.hardDisqualifiers.length, 0);
});

test("experiencia no declarada (null) con requisito minimo -> gap, nunca asume que cumple", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ yearsExperience: null }),
    job: baseJob({ minYearsExperience: 1 }),
  });
  assert.equal(result.experienceGap, true);
});

test("idiomas requeridos faltantes se reportan como gap blando, nunca hard disqualifier", () => {
  const result = evaluateCandidateQualification({
    candidate: baseCandidate({ languages: ["English"] }),
    job: baseJob({ requiredLanguages: ["English", "Spanish"] }),
  });
  assert.deepEqual(result.languageGaps, ["Spanish"]);
  assert.equal(result.hardDisqualifiers.length, 0);
});

test("reasons siempre no vacio -- toda evaluacion es auditable, incluso sin ningun gap", () => {
  const result = evaluateCandidateQualification({ candidate: baseCandidate(), job: baseJob() });
  assert.ok(result.reasons.length > 0);
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input: QualificationEvaluationInput = {
    candidate: baseCandidate({ documents: [verifiedDoc("forklift_cert")] }),
    job: baseJob({ requiredDocumentTypeKeys: ["forklift_cert"], minYearsExperience: 2, requiredLanguages: ["English"] }),
    now: "2026-07-17",
  };
  assert.deepEqual(evaluateCandidateQualification(input), evaluateCandidateQualification(input));
});

test("rulesVersion siempre presente y estable", () => {
  assert.equal(evaluateCandidateQualification({ candidate: baseCandidate(), job: baseJob() }).rulesVersion, 1);
});

// ---------- Fairness (mismo criterio que matching/scoring.test.ts) ----------

test("fairness: el contrato de entrada declara EXACTAMENTE estas claves, ninguna es un atributo protegido", () => {
  const candidate = baseCandidate();
  const allowedKeys = ["candidateId", "status", "categoryIds", "yearsExperience", "languages", "documents"].sort();
  assert.deepEqual(Object.keys(candidate).sort(), allowedKeys, "el contrato de QualificationCandidateInput no debe ganar ni perder campos sin revisión explícita de fairness");
  // Ninguna de las claves permitidas es, ella misma, un atributo protegido.
  const forbiddenKeyNames = ["race", "gender", "age", "religion", "nationality", "disability", "pregnant", "medical", "ethnicity", "dateofbirth", "ssn", "immigrationstatus"];
  for (const key of allowedKeys) {
    assert.ok(!forbiddenKeyNames.includes(key.toLowerCase()), `la clave "${key}" no debe ser un atributo protegido`);
  }
});

test("fairness: dos candidatos identicos en todo lo relevante producen exactamente el mismo resultado (sin variable oculta)", () => {
  const a = evaluateCandidateQualification({ candidate: baseCandidate({ candidateId: "candidate-a" }), job: baseJob() });
  const b = evaluateCandidateQualification({ candidate: baseCandidate({ candidateId: "candidate-b" }), job: baseJob() });
  assert.deepEqual(
    { ...a },
    { ...b },
  );
});
