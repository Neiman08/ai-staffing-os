import { test } from "node:test";
import assert from "node:assert/strict";
import { missionPlanSchema } from "./contracts";
import { interpretBusinessIntent } from "./intent-interpreter";
import { buildMissionPlan } from "./mission-planner";

function plan(rawInstruction: string) {
  const intent = interpretBusinessIntent(rawInstruction);
  const result = buildMissionPlan(intent);
  const parsed = missionPlanSchema.safeParse(result);
  assert.ok(parsed.success, `MissionPlan inválido para "${rawInstruction}": ${JSON.stringify(parsed.error?.format())}`);
  return result;
}

test("un plan de descubrimiento declara discover_companies como el único paso requerido", () => {
  const missionPlan = plan("Busca hoteles que necesiten housekeeping en Chicago.");
  assert.deepEqual(missionPlan.requiredSteps, ["discover_companies"]);
  assert.ok(missionPlan.optionalSteps.includes("validate_business_type"));
  assert.ok(missionPlan.optionalSteps.includes("find_contacts"));
});

test("searchQueries se derivan de la taxonomía matcheada, con su propio crmIndustryBucket", () => {
  const missionPlan = plan("Busca warehouses con Forklift Operators.");
  assert.ok(missionPlan.searchQueries.length > 0);
  assert.ok(missionPlan.searchQueries.every((q) => q.taxonomyKey === "warehousing"));
  assert.ok(missionPlan.searchQueries.every((q) => q.crmIndustryBucket === "Warehouse/Logistics"));
});

test("dedupStrategy siempre declara los 4 niveles cuando hay discover_companies planificado", () => {
  const missionPlan = plan("Busca hoteles en Illinois.");
  assert.deepEqual(missionPlan.dedupStrategy, [
    "providerPlaceId",
    "canonicalDomain",
    "normalizedPhone",
    "normalizedNameCityState",
  ]);
});

test("dedupStrategy queda vacío cuando el plan no incluye discover_companies (búsqueda pura de roles)", () => {
  const missionPlan = plan("Encuentra HR Manager o Plant Manager.");
  assert.deepEqual(missionPlan.dedupStrategy, []);
  assert.deepEqual(missionPlan.requiredSteps, []);
});

test("fallbackStrategy declara Google Places -> Overpass cuando hay discovery planificado", () => {
  const missionPlan = plan("Busca fábricas de alimentos en Illinois.");
  assert.ok(missionPlan.fallbackStrategy.some((f) => f.provider === "Google Places" && f.whenUnavailable.includes("Overpass")));
});

test("fallbackStrategy declara Hunter.io -> Website Intelligence cuando hay búsqueda de emails planificada", () => {
  const missionPlan = plan("Busca hoteles en Illinois.");
  assert.ok(missionPlan.fallbackStrategy.some((f) => f.provider === "Hunter.io"));
  assert.ok(missionPlan.fallbackStrategy.some((f) => f.provider === "People Data Labs"));
});

test("stopConditions.maxCompanies usa el volumen pedido cuando la instrucción trae un número", () => {
  const missionPlan = plan("Busca 15 fábricas de alimentos en Illinois.");
  assert.equal(missionPlan.stopConditions.maxCompanies, 15);
});

test("stopConditions.maxCompanies usa el default cuando no se pidió un número", () => {
  const missionPlan = plan("Busca fábricas de alimentos en Illinois.");
  assert.equal(missionPlan.stopConditions.maxCompanies, 50);
});

test("restrictions del plan reflejan exactamente las del intent (no se recalculan de nuevo)", () => {
  const rawInstruction = "Busca hoteles. No crear campañas ni oportunidades. No enviar correos.";
  const intent = interpretBusinessIntent(rawInstruction);
  const missionPlan = buildMissionPlan(intent);
  assert.deepEqual(missionPlan.restrictions, intent.restrictions);
});

test("rationale es una explicación no vacía y determinista para el mismo intent", () => {
  const intent = interpretBusinessIntent("Busca hoteles que necesiten housekeeping, pero excluye staffing.");
  const a = buildMissionPlan(intent);
  const b = buildMissionPlan(intent);
  assert.ok(a.rationale.length > 0);
  assert.equal(a.rationale, b.rationale);
  assert.ok(a.rationale.includes("staffing"));
});

test("exclusions y cities/states del plan son exactamente los del intent, sin reinterpretar el texto", () => {
  const intent = interpretBusinessIntent("Busca manufactura en Chicago y Aurora.");
  const missionPlan = buildMissionPlan(intent);
  assert.deepEqual(missionPlan.cities, intent.preferredCities);
  assert.deepEqual(missionPlan.states, intent.states);
  assert.deepEqual(missionPlan.exclusions, intent.exclusions);
});

test("invariante del schema: requiredSteps/optionalSteps son subconjuntos disjuntos de steps (falla si no)", () => {
  const missionPlan = plan("Busca hoteles en Illinois.");
  const stepSet = new Set(missionPlan.steps);
  for (const s of missionPlan.requiredSteps) assert.ok(stepSet.has(s));
  for (const s of missionPlan.optionalSteps) assert.ok(stepSet.has(s));
  const requiredSet = new Set(missionPlan.requiredSteps);
  for (const s of missionPlan.optionalSteps) assert.ok(!requiredSet.has(s));
});

// ---------- F15: clientes de infraestructura crítica amplían las queries ----------

test("F15: sin ningún trade/industria mencionado, nunca se inventa 'QTS company' a secas -- ninguna query real que armar", () => {
  const missionPlan = plan("Prioriza empresas relacionadas con QTS, Meta, Google, Microsoft, Amazon AWS, Compass Datacenters en Texas.");
  // La instrucción no menciona ningún trade explícito -- sin taxonomía
  // específica matcheada, nunca se inventa "QTS company contractor" a
  // secas (regla explícita: solo se amplía si ya hay un trade real).
  assert.equal(missionPlan.searchQueries.length, 0);
});

test("F15: combinando un trade real con clientes de infraestructura crítica, cada query lleva el nombre canónico del cliente + el trade real", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS, Meta y Google en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm);
  assert.ok(terms.some((t) => t.toLowerCase().includes("qts")), `esperaba una query con "QTS", tengo: ${JSON.stringify(terms)}`);
  assert.ok(terms.some((t) => t.toLowerCase().includes("meta")));
  assert.ok(terms.some((t) => t.toLowerCase().includes("google")));
  // Las queries base de electrical (sin cliente) también deben seguir presentes.
  assert.ok(terms.some((t) => !t.toLowerCase().includes("qts") && !t.toLowerCase().includes("meta") && !t.toLowerCase().includes("google")));
  // Cada query con cliente lleva taxonomyKey real (electrical), nunca uno inventado.
  const clientQueries = missionPlan.searchQueries.filter((q) => q.searchTerm.toLowerCase().includes("qts"));
  assert.ok(clientQueries.every((q) => q.taxonomyKey === "electrical"));
});

test("F15: las queries client-augmented van PRIMERO en la lista -- 'se prioricen contratistas que trabajen con infraestructura crítica' (el loop de discovery corta apenas alcanza el volumen pedido, así que el orden decide qué realmente se ejecuta)", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS, Meta y Google en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm.toLowerCase());
  const firstClientIndex = terms.findIndex((t) => t.includes("qts") || t.includes("meta") || t.includes("google"));
  const firstBaseIndex = terms.findIndex((t) => !t.includes("qts") && !t.includes("meta") && !t.includes("google"));
  assert.ok(firstClientIndex !== -1 && firstBaseIndex !== -1);
  assert.ok(firstClientIndex < firstBaseIndex, `esperaba que las queries de cliente fueran primero -- orden real: ${JSON.stringify(terms)}`);
});

test("F15: el rationale documenta los clientes de infraestructura crítica detectados", () => {
  const missionPlan = plan("Busca contratistas eléctricos para QTS en Texas.");
  assert.match(missionPlan.rationale, /QTS/);
});

test("F15: sin ningún cliente mencionado, el comportamiento de queries es idéntico al de antes (sin cambios)", () => {
  const missionPlan = plan("Busca contratistas eléctricos reales en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm);
  assert.ok(terms.every((t) => !/qts|meta|google|microsoft|amazon|compass/i.test(t)));
});

// ---------- F16: rediseño de la estrategia de queries (trade-primero, nunca cliente-primero) ----------

test("F16: las queries client-related llevan el TRADE primero, nunca el cliente primero -- el patrón 'cliente + trade' quedó confirmado roto (Google Places devolvía las instalaciones PROPIAS del cliente en vez de contratistas terceros)", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS en Texas.");
  const clientTerms = missionPlan.searchQueries.map((q) => q.searchTerm.toLowerCase()).filter((t) => t.includes("qts"));
  assert.ok(clientTerms.length > 0);
  for (const term of clientTerms) {
    // El trade ("electrical contractor") aparece ANTES que "qts" en cada query.
    assert.ok(term.indexOf("electrical contractor") < term.indexOf("qts"), `esperaba trade-primero, tengo: "${term}"`);
    assert.ok(!term.startsWith("qts"), `nunca debe empezar con el nombre del cliente: "${term}"`);
  }
});

test("F16: estrategia subcontractor -- al menos una query client-related menciona explícitamente 'subcontractor'", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm.toLowerCase());
  assert.ok(terms.some((t) => t.includes("qts") && t.includes("subcontractor")));
});

test("F16: estrategia sector-specific -- independiente de cualquier cliente puntual, cubre calificadores reales de infraestructura crítica (critical infrastructure/substation/industrial), sin duplicar 'data center' cuando el trade ya lo menciona", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm.toLowerCase());
  assert.ok(terms.some((t) => t === "critical infrastructure electrical contractor"));
  assert.ok(terms.some((t) => t === "substation electrical contractor"));
  assert.ok(terms.some((t) => t === "industrial electrical contractor"));
  // Ninguna query real repite "data center" dos veces.
  assert.ok(terms.every((t) => !t.includes("data center data center")));
});

test("F16: las 4 estrategias (client, subcontractor, sector, trade general) coexisten sin pisarse -- todas presentes en una misma misión con cliente detectado", () => {
  const missionPlan = plan("Busca contratistas eléctricos que trabajen en proyectos de QTS en Texas.");
  const terms = missionPlan.searchQueries.map((q) => q.searchTerm.toLowerCase());
  assert.ok(terms.some((t) => t.includes("qts") && !t.includes("subcontractor")), "client strategy");
  assert.ok(terms.some((t) => t.includes("qts") && t.includes("subcontractor")), "subcontractor strategy");
  assert.ok(terms.some((t) => !t.includes("qts") && /critical infrastructure|substation|industrial|data center/.test(t)), "sector strategy");
  assert.ok(terms.some((t) => t === "electrical contractor"), "trade general strategy sin cambios");
});
