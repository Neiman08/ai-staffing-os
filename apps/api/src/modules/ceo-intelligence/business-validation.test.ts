import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBusinessCandidate, type BusinessValidationInput } from "./business-validation";

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

// ---------- Hoteles ----------

test("hotel válido: nombre contiene 'Hotel' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Grand Chicago Hotel", website: "https://grandchicagohotel.com", taxonomyKey: "hospitality" }),
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
  const result = validateBusinessCandidate(baseInput({ candidateName: "ABC Property Management", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.includes("property management"));
});

test("hotel inválido: cleaning contractor -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Sparkle Commercial Cleaning Services", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, false);
});

test("hotel inválido: restaurant -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Downtown Restaurant Group", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, false);
});

// ---------- Manufacturing ----------

test("manufacturing válido: nombre contiene 'Manufacturing' -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, "Manufacturing");
});

test("distributor sin evidencia de fabricación -> rechazado (pure distribution)", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Midwest Pure Distribution Inc.", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("pure distribution"));
});

test("logistics puro excluido de manufacturing", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Regional Logistics Only Co.", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("logistics only"));
});

test("consulting excluido de manufacturing", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Apex Manufacturing Consulting Group", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("consulting"));
});

test("staffing agency excluido de manufacturing", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Industrial Staffing Agency LLC", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("staffing agency"));
});

// ---------- Food Manufacturing ----------

test("food manufacturing válido: 'Food Processing' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Heartland Food Processing LLC", taxonomyKey: "food_manufacturing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Warehousing ----------

test("warehouse válido: nombre contiene 'Warehouse' -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Prairie State Warehouse Co.", taxonomyKey: "warehousing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, "Warehouse/Logistics");
});

test("warehouse: office only -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Regional Office Only Solutions", taxonomyKey: "warehousing" }));
  assert.equal(result.accepted, false);
});

// ---------- Janitorial / Commercial Cleaning ----------

test("janitorial válido: 'Janitorial Services' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Bright Star Janitorial Services", taxonomyKey: "janitorial" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.equal(result.detectedSector, null);
});

test("janitorial: staffing agency -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Facility Staffing Agency Inc.", taxonomyKey: "janitorial" }));
  assert.equal(result.accepted, false);
});

// ---------- Roofing / Electrical / Data Centers / Landscaping / Healthcare / Restaurants ----------
// Mismo algoritmo generico -- ninguna logica especial por categoria.

test("roofing válido: 'Roofing Contractor' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Superior Roofing Contractor", taxonomyKey: "roofing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("electrical válido: 'Electrical Contractor' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Bright Spark Electrical Contractor", taxonomyKey: "electrical" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("data center válido: 'Data Center Operator' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Midwest Data Center Operator", taxonomyKey: "data_centers" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("landscaping válido: 'Landscaping Company' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Green Acres Landscaping Company", taxonomyKey: "landscaping" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("healthcare válido: 'Hospital' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Lakeside Community Hospital", taxonomyKey: "healthcare" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("restaurant válido: 'Restaurant' en nombre -> EXACT", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "The Corner Restaurant", taxonomyKey: "restaurants" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Demo data ----------

test("demo data: un nombre de empresa sembrada (Prairie Manufacturing Co.) valida igual que cualquier otra -- el validador no conoce origin/DEMO_SEED, eso es responsabilidad del dedup en mission-executor.ts", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Prairie Manufacturing Co.", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

// ---------- Niveles de confianza (F16: EXCLUSIVAMENTE evidencia de la empresa, nunca la query de búsqueda) ----------

test("confidence EXACT: providerTypes (Google Places place.types) por sí solo, sin que el nombre matchee nada -- pesa igual que el nombre", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Acme Industries LLC",
      taxonomyKey: "electrical",
      providerTypes: ["electrician", "point_of_interest"],
    }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
  assert.ok(result.sourceSignals.includes("providerTypes"));
});

test("confidence STRONG: sin evidencia en el nombre, pero el dominio contiene la palabra clave", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Acme Industries LLC",
      website: "https://acmewarehouse.com",
      taxonomyKey: "warehousing",
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
      description: "Our manufacturing facility runs a full production line with strict quality control.",
    }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "STRONG");
  assert.ok(result.sourceSignals.includes("description"));
});

test("confidence APPROXIMATE: sin evidencia de la empresa misma, solo actividades de negocio declaradas en la StructuredIntent de la misión", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing", businessActivities: ["factory"] }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "APPROXIMATE");
  assert.deepEqual(result.matchedEvidence, ["factory"]);
});

test("confidence WEAK: ninguna señal de evidencia matcheó nada -- ni nombre, ni providerTypes, ni dominio, ni descripción, ni businessActivities", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "WEAK");
});

// ---------- Rejection reasons ----------

test("rejection reasons: sin nombre utilizable", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: null, taxonomyKey: "manufacturing" }));
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.includes("nombre"));
});

test("rejection reasons: taxonomyKey desconocida", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Acme Co.", taxonomyKey: "no-existe" }));
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("Taxonomy key desconocida"));
});

test("rejection reasons: coincide con una exclusión explícita de la misión", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Staffing Solutions", taxonomyKey: "manufacturing", missionExclusions: ["staffing"] }),
  );
  assert.equal(result.accepted, false);
  assert.ok(result.rejectionReasons[0]!.includes("excluido explícitamente"));
});

// ---------- Determinismo y estructura del contrato ----------

test("misma entrada siempre produce el mismo resultado (determinista)", () => {
  const input = baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing" });
  const a = validateBusinessCandidate(input);
  const b = validateBusinessCandidate(input);
  assert.deepEqual(a, b);
});

test("validationVersion siempre presente y estable", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing" }));
  assert.equal(result.validationVersion, 2);
});

test("missingEvidence queda vacío para EXACT, poblado con entry.validations para niveles menores", () => {
  const exact = validateBusinessCandidate(baseInput({ candidateName: "Acme Manufacturing Co.", taxonomyKey: "manufacturing" }));
  assert.deepEqual(exact.missingEvidence, []);

  const approximate = validateBusinessCandidate(
    baseInput({ candidateName: "Acme Industries LLC", taxonomyKey: "manufacturing", businessActivities: ["factory"] }),
  );
  assert.ok(approximate.missingEvidence.length > 0);
});

// ---------- F16: guardrails permanentes de la arquitectura ----------
// Estos 4 tests son la garantía explícita pedida por el PO de que un
// cambio futuro en la ESTRATEGIA de búsqueda (nuevos clientes,
// industrias, tecnologías, mercados o ubicaciones) nunca puede volver a
// romper la conversión comercial como pasó en F15 -- ver el comentario
// de diseño al inicio de business-validation.ts.

test("F16 guardrail (a): el mismo candidato encontrado por dos 'queries' distintas produce EXACTAMENTE la misma Business Confidence -- BusinessValidationInput no tiene ningún campo de query, así que dos llamadas con la misma evidencia de empresa son indistinguibles para el validador", () => {
  const evidenceFoundByTradeQuery = baseInput({
    candidateName: "Rivertown Electrical Contractor",
    website: "https://rivertownelectrical.com",
    taxonomyKey: "electrical",
    providerTypes: ["electrician"],
  });
  // Evidencia de EMPRESA idéntica -- el único "cambio" real entre las dos
  // llamadas es imaginario (qué query de discovery encontró al
  // candidato), y ese dato ni siquiera existe en este input.
  const evidenceFoundByClientQuery = { ...evidenceFoundByTradeQuery };

  const a = validateBusinessCandidate(evidenceFoundByTradeQuery);
  const b = validateBusinessCandidate(evidenceFoundByClientQuery);
  assert.deepEqual(a, b);
  assert.equal(a.confidence, "EXACT");
});

test("F16 guardrail (b): cambiar únicamente providerTypes cambia la confianza como corresponde -- de WEAK (sin ninguna evidencia) a EXACT (Google categorizó al negocio como el trade real)", () => {
  const withoutProviderTypes = validateBusinessCandidate(
    baseInput({ candidateName: "JR Field Services LLC", taxonomyKey: "electrical", providerTypes: [] }),
  );
  assert.equal(withoutProviderTypes.confidence, "WEAK");

  const withProviderTypes = validateBusinessCandidate(
    baseInput({ candidateName: "JR Field Services LLC", taxonomyKey: "electrical", providerTypes: ["electrician"] }),
  );
  assert.equal(withProviderTypes.confidence, "EXACT");
});

test("F16 guardrail (c): agregar evidencia nueva solo puede mantener o aumentar la confianza, nunca reducirla -- WEAK -> APPROXIMATE (+businessActivities) -> STRONG (+descripción) -> EXACT (+providerTypes)", () => {
  const level0 = validateBusinessCandidate(baseInput({ candidateName: "JR Field Services LLC", taxonomyKey: "electrical" }));
  assert.equal(level0.confidence, "WEAK");

  const level1 = validateBusinessCandidate(
    baseInput({ candidateName: "JR Field Services LLC", taxonomyKey: "electrical", businessActivities: ["electrical contractor"] }),
  );
  assert.equal(level1.confidence, "APPROXIMATE");

  const level2 = validateBusinessCandidate(
    baseInput({
      candidateName: "JR Field Services LLC",
      taxonomyKey: "electrical",
      businessActivities: ["electrical contractor"],
      description: "We are a full-service electrical contractor serving the region.",
    }),
  );
  assert.equal(level2.confidence, "STRONG");

  const level3 = validateBusinessCandidate(
    baseInput({
      candidateName: "JR Field Services LLC",
      taxonomyKey: "electrical",
      businessActivities: ["electrical contractor"],
      description: "We are a full-service electrical contractor serving the region.",
      providerTypes: ["electrician"],
    }),
  );
  assert.equal(level3.confidence, "EXACT");

  const scoreOrder = [level0, level1, level2, level3].map((r) => r.confidenceScore);
  for (let i = 1; i < scoreOrder.length; i++) {
    assert.ok(scoreOrder[i]! >= scoreOrder[i - 1]!, `esperaba que la confianza nunca bajara: ${JSON.stringify(scoreOrder)}`);
  }
});

test("F16 guardrail (d): ninguna estrategia de búsqueda futura puede afectar la clasificación de negocio -- garantía a nivel de TIPOS, no solo de comportamiento: si alguien reintroduce un campo de texto de búsqueda en BusinessValidationInput, esta línea deja de compilar", () => {
  // Chequeo de tipos en tiempo de compilación -- `never` fuerza que
  // "searchTerm" (y cualquier otro nombre plausible de campo de query)
  // NO exista como clave de BusinessValidationInput. Si alguien lo
  // reintroduce, `tsc` falla acá con "Type 'true' is not assignable to
  // type 'false'" mucho antes de llegar a producción.
  type ForbiddenSearchFields = "searchTerm" | "query" | "searchQuery" | "searchStrategy";
  type NoForbiddenFieldPresent = Extract<keyof BusinessValidationInput, ForbiddenSearchFields> extends never ? true : false;
  const guardrail: NoForbiddenFieldPresent = true;
  assert.equal(guardrail, true);
});
