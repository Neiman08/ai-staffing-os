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
