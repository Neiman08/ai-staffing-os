import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendOpportunityAction, type OpportunityRecommendationInput } from "./opportunity-recommendation";

function baseInput(overrides: Partial<OpportunityRecommendationInput> = {}): OpportunityRecommendationInput {
  return {
    businessConfidence: "EXACT",
    missingEvidence: [],
    hasValidEmail: true,
    hiringStatus: "CONFIRMED_HIRING",
    contactsFound: 1,
    bestContactRankingTier: "HIGH_CONFIDENCE",
    rolesWithoutContact: [],
    ...overrides,
  };
}

test("evidencia fuerte y completa -> CREATE_OPPORTUNITY, requiresApproval siempre true", () => {
  const result = recommendOpportunityAction(baseInput());
  assert.equal(result.recommendation, "CREATE_OPPORTUNITY");
  assert.equal(result.requiresApproval, true);
});

test("businessConfidence WEAK -> siempre ARCHIVE, sin importar el resto de la evidencia", () => {
  const result = recommendOpportunityAction(
    baseInput({ businessConfidence: "WEAK", hiringStatus: "CONFIRMED_HIRING", contactsFound: 5, bestContactRankingTier: "HIGH_CONFIDENCE" }),
  );
  assert.equal(result.recommendation, "ARCHIVE");
});

test("businessConfidence REJECTED -> siempre ARCHIVE", () => {
  const result = recommendOpportunityAction(baseInput({ businessConfidence: "REJECTED" }));
  assert.equal(result.recommendation, "ARCHIVE");
});

test("sin contactos y sin señal de contratación -> INVESTIGATE_MORE, nunca CREATE_OPPORTUNITY", () => {
  const result = recommendOpportunityAction(
    baseInput({ hiringStatus: "NO_SIGNAL", contactsFound: 0, bestContactRankingTier: null }),
  );
  assert.notEqual(result.recommendation, "CREATE_OPPORTUNITY");
});

test("único contacto rechazado por el ranking -> nunca CREATE_OPPORTUNITY", () => {
  const result = recommendOpportunityAction(baseInput({ contactsFound: 1, bestContactRankingTier: "REJECTED" }));
  assert.notEqual(result.recommendation, "CREATE_OPPORTUNITY");
  assert.ok(result.risks.some((r) => r.includes("rechazado")));
});

test("roles sin contacto se reportan como riesgo explícito", () => {
  const result = recommendOpportunityAction(baseInput({ rolesWithoutContact: ["Plant Manager"] }));
  assert.ok(result.risks.some((r) => r.includes("Plant Manager")));
});

test("missingEvidence agrega email y contacto faltantes, ademas de lo ya reportado por F7.4", () => {
  const result = recommendOpportunityAction(
    baseInput({ missingEvidence: ["sitio web"], hasValidEmail: false, contactsFound: 0, bestContactRankingTier: null }),
  );
  assert.ok(result.missingEvidence.includes("sitio web"));
  assert.ok(result.missingEvidence.includes("email organizacional válido"));
  assert.ok(result.missingEvidence.includes("contacto de decisión identificado"));
});

test("score siempre acotado entre 0 y 1", () => {
  const result = recommendOpportunityAction(baseInput());
  assert.ok(result.score >= 0 && result.score <= 1);
});

test("nunca recomienda nada distinto de las 4 acciones cerradas", () => {
  const result = recommendOpportunityAction(baseInput({ businessConfidence: "APPROXIMATE", hiringStatus: "UNKNOWN", contactsFound: 0, bestContactRankingTier: null }));
  assert.ok(["CREATE_OPPORTUNITY", "INVESTIGATE_MORE", "ARCHIVE", "MANUAL_REVIEW"].includes(result.recommendation));
});

test("determinismo: misma entrada siempre produce el mismo resultado", () => {
  const input = baseInput();
  assert.deepEqual(recommendOpportunityAction(input), recommendOpportunityAction(input));
});

test("recommendationVersion siempre presente y estable", () => {
  assert.equal(recommendOpportunityAction(baseInput()).recommendationVersion, 1);
});

test("nextBestAction siempre un texto no vacio", () => {
  const result = recommendOpportunityAction(baseInput());
  assert.ok(result.nextBestAction.length > 0);
});
