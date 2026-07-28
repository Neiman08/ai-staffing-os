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
    allowedStates: [],
    missionSpecificTaxonomyKeys: [],
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

// F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
// categorías comerciales nuevas (Conference Hotel/Extended Stay/cadenas)
// deben reconocerse -- y B&B/Guest House/Inn siguen aceptándose (nunca
// excluidos, solo despriorizados en el orden de búsqueda -- ver
// taxonomy.test.ts).
test("hotel comercial válido: 'Riverside Conference Hotel & Suites' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Riverside Conference Hotel & Suites", taxonomyKey: "hospitality" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("hotel comercial válido: 'Meridian Extended Stay Hotel Chicago' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Meridian Extended Stay Hotel Chicago", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("cadena hotelera válida: 'Windsor Hotel Chain Group' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Windsor Hotel Chain Group", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("bed and breakfast sigue siendo válido -- despriorizado en orden de búsqueda, nunca rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Maple Street Bed and Breakfast", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, true);
});

test("guest house sigue siendo válido -- despriorizado, nunca rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Lakeside Guest House", taxonomyKey: "hospitality" }));
  assert.equal(result.accepted, true);
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

// ---------- F28: restricción geográfica estricta (hallazgo real 2026-07-27) ----------

test("estado real fuera de allowedStates -> REJECTED, sin importar la evidencia de industria", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Roofing Contractor", taxonomyKey: "roofing", state: "IN", allowedStates: ["IL"] }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.includes("IN"));
});

test("estado real dentro de allowedStates -> nunca se rechaza por geografía", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Roofing Contractor", taxonomyKey: "roofing", state: "IL", allowedStates: ["IL"] }),
  );
  assert.equal(result.accepted, true);
});

test("allowedStates vacío (la misión no restringió ningún estado) -> nunca rechaza por geografía", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Roofing Contractor", taxonomyKey: "roofing", state: "IN", allowedStates: [] }),
  );
  assert.equal(result.accepted, true);
});

test("state real desconocido (null, proveedor sin address_components) -> nunca rechaza por geografía (no se inventa evidencia)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Roofing Contractor", taxonomyKey: "roofing", state: null, allowedStates: ["IL"] }),
  );
  assert.equal(result.accepted, true);
});

// ---------- F28: validación de industria para roofing (hallazgo real 2026-07-27) ----------
// "IRPINO Construction", "BEAR Construction Company", "Cruz Construction
// Company", "State Construction Co", "Walton Contractors" -- 5 empresas
// generales de construcción que la misión real de roofing aceptó como
// si fueran roofing, únicamente por venir de la query genérica
// "construction company" y pertenecer al mismo bucket Construction.

test("data center encontrado vía la query genérica 'construction company' en una misión de roofing -> RECHAZADO (sin evidencia real de roofing)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "IRPINO Construction", taxonomyKey: "construction", missionSpecificTaxonomyKeys: ["roofing"] }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
  assert.ok(result.rejectionReasons[0]!.toLowerCase().includes("roofing"));
});

test("general contractor genérico ('BEAR Construction Company') en una misión de roofing -> RECHAZADO", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "BEAR Construction Company", taxonomyKey: "construction", missionSpecificTaxonomyKeys: ["roofing"] }),
  );
  assert.equal(result.accepted, false);
});

test("candidato de la query genérica CON evidencia real de roofing en el nombre -> aceptado (la señal exigida SÍ está presente)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Roofing & Construction", taxonomyKey: "construction", missionSpecificTaxonomyKeys: ["roofing"] }),
  );
  assert.equal(result.accepted, true);
});

test("candidato de la query genérica CON evidencia real de roofing en providerTypes (categoría real de Google Places) -> aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Prairie State Builders",
      taxonomyKey: "construction",
      missionSpecificTaxonomyKeys: ["roofing"],
      providerTypes: ["roofing_contractor"],
    }),
  );
  assert.equal(result.accepted, true);
});

test("candidato de la query genérica CON descripción real que confirma instalación/reparación de techos -> aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Prairie State Builders",
      taxonomyKey: "construction",
      missionSpecificTaxonomyKeys: ["roofing"],
      description: "We specialize in roof repair and roof installation for commercial properties.",
    }),
  );
  assert.equal(result.accepted, true);
});

test("un candidato encontrado DIRECTAMENTE por la query específica 'roofing contractor' (taxonomyKey=roofing, no genérica) nunca se ve afectado por este chequeo cruzado, sin importar missionSpecificTaxonomyKeys", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "Champion Roofing Company", taxonomyKey: "roofing", missionSpecificTaxonomyKeys: ["roofing"] }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT", "roofing no es isGenericFallback -- el chequeo cruzado nunca se activa para su propia entrada específica");
});

test("sin ningún trade específico en la misión (missionSpecificTaxonomyKeys vacío), la query genérica se acepta como siempre (comportamiento preexistente para misiones genéricas reales)", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "IRPINO Construction", taxonomyKey: "construction", missionSpecificTaxonomyKeys: [] }),
  );
  assert.equal(result.accepted, true);
});

// ---------- F28: Landscaping & Lawn Care (misión real 2026-07-27) ----------

test("landscaping válido: 'ABC Lawn Care & Landscape Maintenance' -> EXACT, aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({ candidateName: "ABC Lawn Care & Landscape Maintenance", website: "https://abclawncare.com", taxonomyKey: "landscaping" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, "EXACT");
});

test("landscaping válido: descripción real de instalación/mantenimiento comercial -> STRONG, aceptado", () => {
  const result = validateBusinessCandidate(
    baseInput({
      candidateName: "Midwest Grounds Solutions",
      description: "We provide commercial landscaping and lawn maintenance for offices and HOAs across the region.",
      taxonomyKey: "landscaping",
    }),
  );
  assert.equal(result.accepted, true);
  assert.ok(result.confidence === "STRONG" || result.confidence === "EXACT");
});

test("landscaping inválido: garden center / vivero -> rechazado (retail/supply, no servicio)", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Green Valley Garden Center", taxonomyKey: "landscaping" }));
  assert.equal(result.accepted, false);
  assert.equal(result.confidence, "REJECTED");
});

test("landscaping inválido: nursery -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Oak Hill Nursery", taxonomyKey: "landscaping" }));
  assert.equal(result.accepted, false);
});

test("landscaping inválido: mulch supplier -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Central Illinois Mulch Supplier", taxonomyKey: "landscaping" }));
  assert.equal(result.accepted, false);
});

test("landscaping inválido: landscape supply store -> rechazado", () => {
  const result = validateBusinessCandidate(baseInput({ candidateName: "Prairie Landscape Supply Store", taxonomyKey: "landscaping" }));
  assert.equal(result.accepted, false);
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
