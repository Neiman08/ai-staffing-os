import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBusinessCandidate, type BusinessValidationInput } from "./business-validation";
import { deriveCommercialStatus, evaluateBusinessIdentityGate } from "./conversion-policy";

/**
 * F18: hallazgo real -- una misión "Busca hoteles en Illinois" terminó
 * con Companies de Data Centers (CoreSite, Equinix, Aligned, 360
 * Technology Center Solutions...) archivadas como si fueran Hospitality.
 * Estas pruebas fijan, para cada par industria-pedida/candidato-real que
 * el PO pidió explícitamente cubrir, que la cadena completa
 * (validateBusinessCandidate -> deriveCommercialStatus ->
 * evaluateBusinessIdentityGate) SIEMPRE termina bloqueando la conversión
 * comercial cuando el candidato no pertenece de verdad a la industria
 * pedida -- sin importar cuál sea el par.
 */

function baseInput(overrides: Partial<BusinessValidationInput>): BusinessValidationInput {
  return {
    candidateName: null,
    website: null,
    taxonomyKey: "",
    city: null,
    state: null,
    missionExclusions: [],
    providerTypes: [],
    description: null,
    businessActivities: [],
    ...overrides,
  };
}

function assertNeverCommerciallyEligible(input: BusinessValidationInput, label: string) {
  const validation = validateBusinessCandidate(input);
  // Si fue explícitamente REJECTED (evidencia negativa), ni siquiera se
  // persiste como Company (mission-executor.ts). Si "accepted" (sin
  // evidencia negativa, pero tampoco positiva -> WEAK), sigue sin ser
  // elegible para Lead/Opportunity vía el gate de F18.
  assert.notEqual(validation.confidence, "EXACT", `${label}: nunca debería alcanzar EXACT`);
  assert.notEqual(validation.confidence, "STRONG", `${label}: nunca debería alcanzar STRONG`);
  const status = deriveCommercialStatus(validation.confidence);
  const gate = evaluateBusinessIdentityGate(status);
  assert.equal(gate.allowed, false, `${label}: terminó comercialmente elegible (confidence=${validation.confidence})`);
}

test("misión de hoteles nunca puede convertir un Data Center en Company comercial (CoreSite)", () => {
  assertNeverCommerciallyEligible(
    baseInput({ candidateName: "CoreSite", website: "https://www.coresite.com", taxonomyKey: "hospitality" }),
    "CoreSite vs hospitality",
  );
});

test("misión de hoteles nunca puede convertir un Data Center en Company comercial (Equinix)", () => {
  assertNeverCommerciallyEligible(
    baseInput({ candidateName: "Equinix Data Center", website: "https://www.equinix.com", taxonomyKey: "hospitality" }),
    "Equinix vs hospitality",
  );
});

test("misión de hoteles nunca puede convertir un Data Center en Company comercial (360 Technology Center Solutions)", () => {
  assertNeverCommerciallyEligible(
    baseInput({ candidateName: "360 Technology Center Solutions", taxonomyKey: "hospitality" }),
    "360 Technology Center Solutions vs hospitality",
  );
});

test("misión de roofing nunca puede convertir un hotel en Company comercial", () => {
  assertNeverCommerciallyEligible(
    baseInput({ candidateName: "Grand Chicago Hotel & Resort", website: "https://grandchicagohotel.com", taxonomyKey: "roofing" }),
    "hotel vs roofing",
  );
});

test("misión de contratistas eléctricos nunca puede convertir un restaurante en Company comercial", () => {
  assertNeverCommerciallyEligible(
    baseInput({ candidateName: "Mario's Italian Restaurant", taxonomyKey: "electrical" }),
    "restaurante vs electrical",
  );
});

test("defensa en profundidad: un candidato de Data Center con nombre genérico es REJECTED explícitamente contra hospitality (negativeKeywords cruzadas)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Uptown Data Center Solutions", taxonomyKey: "hospitality" }),
  );
  assert.equal(result.confidence, "REJECTED");
  assert.equal(result.accepted, false);
});

test("defensa en profundidad: un hotel es REJECTED explícitamente contra data_centers (negativeKeywords cruzadas)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Lakeside Resort & Spa", taxonomyKey: "data_centers" }),
  );
  assert.equal(result.confidence, "REJECTED");
  assert.equal(result.accepted, false);
});
