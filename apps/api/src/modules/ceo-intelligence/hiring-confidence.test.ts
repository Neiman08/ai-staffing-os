import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHiringConfidence, type HiringConfidenceInput } from "./hiring-confidence";

function baseInput(overrides: Partial<HiringConfidenceInput>): HiringConfidenceInput {
  return {
    hiringSignalStatus: null,
    hiringSignalTitlesMatched: [],
    hasCareersPage: false,
    organizationalEmailsVerified: 0,
    organizationalEmailsRisky: 0,
    namedContactsFound: 0,
    bestContactRankingTier: null,
    ...overrides,
  };
}

test("sin ninguna señal -> NONE, sin evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({}));
  assert.equal(result.tier, "NONE");
  assert.equal(result.concreteEvidence, false);
  assert.deepEqual(result.matchedSignals, []);
});

test("hiringStatus CONFIRMED_HIRING -> HIGH", () => {
  const result = computeHiringConfidence(baseInput({ hiringSignalStatus: "CONFIRMED_HIRING" }));
  assert.equal(result.tier, "HIGH");
});

test("hiringStatus LIKELY_HIRING -> HIGH", () => {
  const result = computeHiringConfidence(baseInput({ hiringSignalStatus: "LIKELY_HIRING" }));
  assert.equal(result.tier, "HIGH");
});

test("contacto real HIGH_CONFIDENCE -> HIGH, aunque no haya señal de contratación", () => {
  const result = computeHiringConfidence(baseInput({ bestContactRankingTier: "HIGH_CONFIDENCE" }));
  assert.equal(result.tier, "HIGH");
});

test("hiringStatus POSSIBLE_HIRING -> MEDIUM", () => {
  const result = computeHiringConfidence(baseInput({ hiringSignalStatus: "POSSIBLE_HIRING" }));
  assert.equal(result.tier, "MEDIUM");
});

test("puestos reales detectados (hiringSignalTitlesMatched) -> MEDIUM + evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({ hiringSignalTitlesMatched: ["Electrician"] }));
  assert.equal(result.tier, "MEDIUM");
  assert.equal(result.concreteEvidence, true);
});

test("email organizacional verificado -> MEDIUM + evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({ organizationalEmailsVerified: 1 }));
  assert.equal(result.tier, "MEDIUM");
  assert.equal(result.concreteEvidence, true);
});

test("contacto nombrado real encontrado -> MEDIUM + evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({ namedContactsFound: 1 }));
  assert.equal(result.tier, "MEDIUM");
  assert.equal(result.concreteEvidence, true);
});

test("solo página de carreras -> LOW, sin evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({ hasCareersPage: true }));
  assert.equal(result.tier, "LOW");
  assert.equal(result.concreteEvidence, false);
});

test("solo email organizacional risky -> LOW, sin evidencia concreta", () => {
  const result = computeHiringConfidence(baseInput({ organizationalEmailsRisky: 1 }));
  assert.equal(result.tier, "LOW");
  assert.equal(result.concreteEvidence, false);
});

test("HIGH domina sobre señales MEDIUM/LOW presentes al mismo tiempo", () => {
  const result = computeHiringConfidence(
    baseInput({ hiringSignalStatus: "CONFIRMED_HIRING", hasCareersPage: true, organizationalEmailsVerified: 1 }),
  );
  assert.equal(result.tier, "HIGH");
});

test("determinista -- misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput({ hiringSignalStatus: "POSSIBLE_HIRING", namedContactsFound: 2 });
  const a = computeHiringConfidence(input);
  const b = computeHiringConfidence(input);
  assert.deepEqual(a, b);
});

test("independiente de Business Confidence -- HiringConfidenceInput no tiene ningún campo de evidencia de negocio (nombre/dominio/providerTypes/descripción)", () => {
  type ForbiddenBusinessFields = "candidateName" | "website" | "providerTypes" | "description" | "businessActivities";
  type NoBusinessFieldPresent = Extract<keyof HiringConfidenceInput, ForbiddenBusinessFields> extends never ? true : false;
  const guardrail: NoBusinessFieldPresent = true;
  assert.equal(guardrail, true);
});
