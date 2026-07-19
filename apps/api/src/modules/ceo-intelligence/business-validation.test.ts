import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBusinessCandidate, type BusinessValidationInput } from "./business-validation";

function baseInput(overrides: Partial<BusinessValidationInput>): BusinessValidationInput {
  return {
    candidateName: null,
    website: null,
    searchTerm: "",
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

// ---------- Hoteles ----------

test("hotel válido: nombre contiene 'Hotel' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Grand Chicago Hotel", website: "https://grandchicagohotel.com", taxonomyKey: "hospitality", searchTerm: "hotel" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.ok(result.matchedEvidence.includes("hotel"));
  // F13 (auditoría PO, 2026-07-19): Hospitality ahora tiene Industry real
  // (crmIndustryBucket="Hospitality", antes null) -- detectedSector la
  // refleja directamente (business-validation.ts:216).
  assert.equal(result.detectedSector, "Hospitality");
});

test("hotel inválido: 'ABC Property Management' -> rechazado por evidencia negativa", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Property Management", taxonomyKey: "hospitality", searchTerm: "hotel" }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.includes("property management"));
});

test("hotel inválido: cleaning contractor -> rechazado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Sparkle Commercial Cleaning Services", taxonomyKey: "hospitality", searchTerm: "hotel" }),
  );
  assert.equal(result.accepted, false);
});

test("hotel inválido: restaurant -> rechazado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Downtown Restaurant Group", taxonomyKey: "hospitality", searchTerm: "hotel" }),
  );
  assert.equal(result.accepted, false);
});

// ---------- Manufacturing ----------

test("manufacturing válido: nombre contiene 'Manufacturing' -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, "Manufacturing");
});

test("distributor sin evidencia de fabricación -> rechazado (pure distribution)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Midwest Pure Distribution Inc.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("pure distribution"));
});

test("logistics puro excluido de manufacturing", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Regional Logistics Only Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("logistics only"));
});

test("consulting excluido de manufacturing", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Apex Manufacturing Consulting Group", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("consulting"));
});

test("staffing agency excluido de manufacturing", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Industrial Staffing Agency LLC", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("staffing agency"));
});

// ---------- Food Manufacturing ----------

test("food manufacturing válido: 'Food Processing' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Heartland Food Processing LLC", taxonomyKey: "food_manufacturing", searchTerm: "food manufacturing company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Warehousing ----------

test("warehouse válido: nombre contiene 'Warehouse' -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Prairie State Warehouse Co.", taxonomyKey: "warehousing", searchTerm: "warehouse company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, "Warehouse/Logistics");
});

test("warehouse: office only -> rechazado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Regional Office Only Solutions", taxonomyKey: "warehousing", searchTerm: "warehouse company" }),
  );
  assert.equal(result.accepted, false);
});

// ---------- Janitorial / Commercial Cleaning ----------

test("janitorial válido: 'Janitorial Services' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Bright Star Janitorial Services", taxonomyKey: "janitorial", searchTerm: "janitorial services company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, null);
});

test("janitorial: staffing agency -> rechazado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Facility Staffing Agency Inc.", taxonomyKey: "janitorial", searchTerm: "janitorial services company" }),
  );
  assert.equal(result.accepted, false);
});

// ---------- Roofing / Electrical / Data Centers / Landscaping / Healthcare / Restaurants ----------
// Mismo algoritmo generico -- ninguna logica especial por categoria.

test("roofing válido: 'Roofing Contractor' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Superior Roofing Contractor", taxonomyKey: "roofing", searchTerm: "roofing contractor" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("electrical válido: 'Electrical Contractor' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Bright Spark Electrical Contractor", taxonomyKey: "electrical", searchTerm: "electrical contractor" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("data center válido: 'Data Center Operator' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Midwest Data Center Operator", taxonomyKey: "data_centers", searchTerm: "data center construction" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("landscaping válido: 'Landscaping Company' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Green Acres Landscaping Company", taxonomyKey: "landscaping", searchTerm: "landscaping company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("healthcare válido: 'Hospital' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Lakeside Community Hospital", taxonomyKey: "healthcare", searchTerm: "hospital" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("restaurant válido: 'Restaurant' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "The Corner Restaurant", taxonomyKey: "restaurants", searchTerm: "restaurant" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Demo data ----------

test("demo data: un nombre de empresa sembrada (Prairie Manufacturing Co.) valida igual que cualquier otra -- el validador no conoce origin/DEMO_SEED, eso es responsabilidad del dedup en mission-executor.ts", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Prairie Manufacturing Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Niveles de confianza ----------

test("confidence STRONG: sin evidencia en el nombre, pero el dominio contiene la palabra clave", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Acme Industries LLC",
      website: "https://acmewarehouse.com",
      taxonomyKey: "warehousing",
      searchTerm: "warehouse company",
    }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "STRONG");
  assert.ok(result.sourceSignals.includes("website"));
});

test("confidence STRONG: descripción pública menciona evidencia de website phrase", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Acme Industries LLC",
      taxonomyKey: "manufacturing",
      searchTerm: "manufacturing company",
      description: "Our manufacturing facility runs a full production line with strict quality control.",
    }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "STRONG");
  assert.ok(result.sourceSignals.includes("description"));
});

test("confidence APPROXIMATE: sin evidencia positiva alguna, pero la query es una de las googleSearchPhrases de la taxonomía", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing", searchTerm: "industrial manufacturer" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "APPROXIMATE");
  assert.deepEqual(result.matchedEvidence, []);
});

test("confidence WEAK: sin evidencia positiva y searchTerm no coincide con ninguna googleSearchPhrase de la taxonomía", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing", searchTerm: "custom search phrase not in taxonomy" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "WEAK");
});

// ---------- Rejection reasons ----------

test("rejection reasons: sin nombre utilizable", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: null, taxonomyKey: "manufacturing", searchTerm: "x" }));
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.includes("nombre"));
});

test("rejection reasons: taxonomyKey desconocida", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Acme Co.", taxonomyKey: "no-existe", searchTerm: "x" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("Taxonomy key desconocida"));
});

test("rejection reasons: coincide con una exclusión explícita de la misión", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Staffing Solutions", taxonomyKey: "manufacturing", searchTerm: "x", missionExclusions: ["staffing"] }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("excluido explícitamente"));
});

// ---------- Determinismo y estructura del contrato ----------

test("misma entrada siempre produce el mismo resultado (determinista)", () => {
  const input = baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" });
  const a = validateBusinessCandidate(input);
  const b = validateBusinessCandidate(input);
  assert.deepEqual(a, b);
});

test("validationVersion siempre presente y estable", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.equal(result.validationVersion, 1);
});

test("missingEvidence queda vacío para EXACT, poblado con entry.validations para niveles menores", () => {
  const exact = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing", searchTerm: "manufacturing company" }),
  );
  assert.deepEqual(exact.missingEvidence, []);

  const approximate = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing", searchTerm: "industrial manufacturer" }),
  );
  assert.ok(approximate.missingEvidence.length > 0);
});
