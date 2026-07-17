import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceCandidatesForJob, type SourcingCandidateInput, type CandidateSourcingInput } from "./candidate-sourcing";

function candidate(overrides: Partial<SourcingCandidateInput> = {}): SourcingCandidateInput {
  return {
    candidateId: "candidate-1",
    status: "NEW",
    categoryIds: ["category-forklift-operator"],
    yearsExperience: 2,
    state: "IL",
    createdAt: "2026-01-01",
    ...overrides,
  };
}

function baseInput(overrides: Partial<CandidateSourcingInput> = {}): CandidateSourcingInput {
  return {
    candidates: [candidate()],
    job: { categoryId: "category-forklift-operator", state: "IL" },
    ...overrides,
  };
}

test("candidato con categoria coincidente y status elegible se incluye en sourced", () => {
  const result = sourceCandidatesForJob(baseInput());
  assert.equal(result.sourced.length, 1);
  assert.equal(result.sourced[0]!.candidateId, "candidate-1");
  assert.equal(result.excluded.length, 0);
});

test("candidato sin la categoria requerida se excluye, nunca se incluye 'por si acaso'", () => {
  const result = sourceCandidatesForJob(baseInput({ candidates: [candidate({ categoryIds: ["category-electrician"] })] }));
  assert.equal(result.sourced.length, 0);
  assert.equal(result.excluded.length, 1);
  assert.ok(result.excluded[0]!.reason.includes("categoría"));
});

test("candidato REJECTED o INACTIVE siempre se excluye del sourcing, sin importar la categoria", () => {
  const rejected = sourceCandidatesForJob(baseInput({ candidates: [candidate({ status: "REJECTED" })] }));
  assert.equal(rejected.sourced.length, 0);
  const inactive = sourceCandidatesForJob(baseInput({ candidates: [candidate({ status: "INACTIVE" })] }));
  assert.equal(inactive.sourced.length, 0);
});

test("candidato NEW/SCREENING/QUALIFIED/PLACED con categoria coincidente nunca se excluye por status", () => {
  for (const status of ["NEW", "SCREENING", "QUALIFIED", "PLACED"]) {
    const result = sourceCandidatesForJob(baseInput({ candidates: [candidate({ status })] }));
    assert.equal(result.sourced.length, 1, status);
  }
});

test("mismo estado que el Job Order puntua mas alto que un estado distinto", () => {
  const sameState = sourceCandidatesForJob(baseInput({ candidates: [candidate({ candidateId: "same-state", state: "IL" })] }));
  const otherState = sourceCandidatesForJob(baseInput({ candidates: [candidate({ candidateId: "other-state", state: "TX" })] }));
  assert.ok(sameState.sourced[0]!.relevanceScore > otherState.sourced[0]!.relevanceScore);
});

test("mas experiencia puntua mas alto, pero nunca excluye a alguien con poca experiencia", () => {
  const result = sourceCandidatesForJob(
    baseInput({
      candidates: [candidate({ candidateId: "senior", yearsExperience: 10 }), candidate({ candidateId: "junior", yearsExperience: 0 })],
    }),
  );
  assert.equal(result.sourced.length, 2);
  assert.equal(result.sourced[0]!.candidateId, "senior");
});

test("orden de salida siempre por relevanceScore descendente", () => {
  const result = sourceCandidatesForJob(
    baseInput({
      candidates: [
        candidate({ candidateId: "low", yearsExperience: 0, state: "TX" }),
        candidate({ candidateId: "high", yearsExperience: 10, state: "IL" }),
      ],
    }),
  );
  assert.deepEqual(result.sourced.map((s) => s.candidateId), ["high", "low"]);
});

test("relevanceScore siempre acotado entre 0 y 1", () => {
  const result = sourceCandidatesForJob(baseInput({ candidates: [candidate({ yearsExperience: 100 })] }));
  assert.ok(result.sourced[0]!.relevanceScore <= 1);
});

test("reasons siempre no vacio para cada candidato sourced -- toda inclusion es auditable", () => {
  const result = sourceCandidatesForJob(baseInput());
  assert.ok(result.sourced[0]!.reasons.length > 0);
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput();
  assert.deepEqual(sourceCandidatesForJob(input), sourceCandidatesForJob(input));
});

test("sourcingVersion siempre presente y estable", () => {
  assert.equal(sourceCandidatesForJob(baseInput()).sourcingVersion, 1);
});
