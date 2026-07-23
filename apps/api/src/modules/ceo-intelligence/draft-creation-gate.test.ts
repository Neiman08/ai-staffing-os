import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDraftCreationGate, type DraftCreationGateInput } from "./draft-creation-gate";

function baseInput(overrides: Partial<DraftCreationGateInput> = {}): DraftCreationGateInput {
  return {
    companyOrigin: "API_PROVIDER",
    isClientOwnerCandidate: false,
    opportunityRecommendation: null,
    channel: { isEmailCapable: true, channel: "VERIFIED_ORG_EMAIL", reason: "test" },
    hasActiveDuplicateApproval: false,
    ...overrides,
  };
}

test("permite el borrador cuando todo está en orden", () => {
  const r = evaluateDraftCreationGate(baseInput());
  assert.equal(r.allowed, true);
  assert.equal(r.blockReason, null);
});

test("bloquea DEMO_SEED sin importar el resto de las condiciones", () => {
  const r = evaluateDraftCreationGate(baseInput({ companyOrigin: "DEMO_SEED" }));
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "DEMO_SEED");
  assert.equal(r.companyBlockReasonToPersist, null, "DEMO_SEED ya es identificable por Company.origin, no se duplica");
});

test("bloquea un duplicado activo, incluso con canal email disponible", () => {
  const r = evaluateDraftCreationGate(baseInput({ hasActiveDuplicateApproval: true }));
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "DUPLICATE_ACTIVE");
  assert.equal(r.companyBlockReasonToPersist, null, "un duplicado ya es identificable por el ApprovalRequest activo existente");
});

test("bloquea isClientOwnerCandidate=true y lo persiste como CLIENT_OWNER_REVIEW", () => {
  const r = evaluateDraftCreationGate(baseInput({ isClientOwnerCandidate: true }));
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "CLIENT_OWNER_REVIEW");
  assert.equal(r.companyBlockReasonToPersist, "CLIENT_OWNER_REVIEW");
});

test("bloquea opportunityRecommendation=MANUAL_REVIEW aunque isClientOwnerCandidate sea false", () => {
  const r = evaluateDraftCreationGate(baseInput({ opportunityRecommendation: "MANUAL_REVIEW" }));
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "CLIENT_OWNER_REVIEW");
});

test("caso real QTS DC6 / Meta Data Center: isClientOwnerCandidate=true + APPROXIMATE + MANUAL_REVIEW -- nunca genera outreach automático", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ isClientOwnerCandidate: true, opportunityRecommendation: "MANUAL_REVIEW", channel: { isEmailCapable: false, channel: "NONE", reason: "sin canal" } }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "CLIENT_OWNER_REVIEW", "el problema de fondo (empresa mal dirigida) precede al de canal");
});

test("bloquea sin canal email-capable y lo persiste como NEEDS_ENRICHMENT", () => {
  const r = evaluateDraftCreationGate(baseInput({ channel: { isEmailCapable: false, channel: "PHONE", reason: "solo teléfono" } }));
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "NEEDS_ENRICHMENT");
  assert.equal(r.companyBlockReasonToPersist, "NEEDS_ENRICHMENT");
});

test("precedencia: DEMO_SEED gana incluso sobre un duplicado activo o client-owner", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ companyOrigin: "DEMO_SEED", hasActiveDuplicateApproval: true, isClientOwnerCandidate: true }),
  );
  assert.equal(r.blockReason, "DEMO_SEED");
});

test("precedencia: duplicado activo gana sobre client-owner y sobre falta de canal", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ hasActiveDuplicateApproval: true, isClientOwnerCandidate: true, channel: { isEmailCapable: false, channel: "NONE", reason: "x" } }),
  );
  assert.equal(r.blockReason, "DUPLICATE_ACTIVE");
});
