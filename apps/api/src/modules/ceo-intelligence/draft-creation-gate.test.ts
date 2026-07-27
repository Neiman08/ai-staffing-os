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

// ---------- F27 (Internal Acceptance Test): defensa en profundidad -- 2 señales independientes deben coincidir ----------

test("INTERNAL_TEST_EMAIL: permitido cuando companyOrigin también es INTERNAL_TEST (par de señales coincide)", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ companyOrigin: "INTERNAL_TEST", channel: { isEmailCapable: true, channel: "INTERNAL_TEST_EMAIL", reason: "test" } }),
  );
  assert.equal(r.allowed, true);
  assert.equal(r.blockReason, null);
});

test("INTERNAL_TEST_EMAIL: bloqueado si companyOrigin NO es INTERNAL_TEST -- nunca confía solo en el canal del contacto", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ companyOrigin: "API_PROVIDER", channel: { isEmailCapable: true, channel: "INTERNAL_TEST_EMAIL", reason: "test" } }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "INTERNAL_TEST_NOT_AUTHORIZED");
});

test("INTERNAL_TEST_EMAIL: companyOrigin=INTERNAL_TEST por sí solo, SIN el canal correspondiente, sigue el camino normal (nunca se autoriza por el origin solo)", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ companyOrigin: "INTERNAL_TEST", channel: { isEmailCapable: false, channel: "NONE", reason: "sin canal" } }),
  );
  assert.equal(r.allowed, false);
  assert.equal(r.blockReason, "NEEDS_ENRICHMENT", "un origin INTERNAL_TEST sin el channel correspondiente cae al chequeo normal de canal, nunca se autoriza gratis");
});

test("INTERNAL_TEST_EMAIL: DEMO_SEED sigue ganando incluso si el canal fuera (hipotéticamente) INTERNAL_TEST_EMAIL", () => {
  const r = evaluateDraftCreationGate(
    baseInput({ companyOrigin: "DEMO_SEED", channel: { isEmailCapable: true, channel: "INTERNAL_TEST_EMAIL", reason: "test" } }),
  );
  assert.equal(r.blockReason, "DEMO_SEED");
});
