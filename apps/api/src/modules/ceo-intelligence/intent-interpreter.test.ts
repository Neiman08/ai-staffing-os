import { test } from "node:test";
import assert from "node:assert/strict";
import { structuredIntentSchema } from "./contracts";
import { interpretBusinessIntent } from "./intent-interpreter";

// F7.1: batería de interpretación -- todas las instrucciones de ejemplo
// que el PO pidió explícitamente cubrir, más los casos estructurales
// (múltiples ciudades, múltiples exclusiones, restricciones, ambigüedad,
// sinónimos). Cada test valida contra structuredIntentSchema primero
// (nunca confía en que el objeto "se ve bien"), y después hace
// aserciones puntuales de contenido.

function interpret(rawInstruction: string) {
  const result = interpretBusinessIntent(rawInstruction);
  const parsed = structuredIntentSchema.safeParse(result);
  assert.ok(parsed.success, `StructuredIntent inválido para "${rawInstruction}": ${JSON.stringify(parsed.error?.format())}`);
  return result;
}

test("hoteles: 'Busca hoteles que necesiten housekeeping.'", () => {
  const intent = interpret("Busca hoteles que necesiten housekeeping.");
  assert.ok(intent.companyTypes.includes("hotel"));
  assert.ok(intent.matchedTaxonomyKeys.includes("hospitality"));
  assert.equal(intent.industries.length, 0, "Hospitality no tiene Industry real hoy — interpretación conservadora");
  assert.ok(intent.hiringSignals.includes("Housekeeper"));
  assert.ok(intent.targetJobTitles.includes("Housekeeping"));
  assert.ok(intent.decisionRoles.includes("HR Manager"));
  assert.ok(intent.plannedSteps.includes("discover_companies"));
  assert.ok(intent.plannedSteps.includes("find_hiring_signals"));
  assert.ok(intent.ambiguities.some((a) => a.includes("crmIndustryBucket")));
  assert.equal(intent.objective.type, "find_companies");
});

test("hoteles: 'Busca hoteles con vacantes de Room Attendant.' (título literal en singular, texto también singular)", () => {
  const intent = interpret("Busca hoteles con vacantes de Room Attendant.");
  assert.ok(intent.companyTypes.includes("hotel"));
  assert.ok(intent.targetJobTitles.includes("Room Attendant"));
});

test("healthcare: 'Busca hospitales que necesiten personal de limpieza.' (sinónimo en español para el título)", () => {
  const intent = interpret("Busca hospitales que necesiten personal de limpieza.");
  assert.ok(intent.companyTypes.includes("hospital"));
  assert.ok(intent.matchedTaxonomyKeys.includes("healthcare"));
  assert.equal(intent.industries.length, 0);
  assert.ok(intent.targetJobTitles.includes("personal de limpieza"));
  assert.ok(intent.decisionRoles.includes("Facilities Manager"));
});

test("food manufacturing: 'Busca empresas manufactureras de alimentos.' (SÍ tiene bucket real de Manufacturing)", () => {
  const intent = interpret("Busca empresas manufactureras de alimentos.");
  assert.ok(intent.matchedTaxonomyKeys.includes("food_manufacturing"));
  assert.deepEqual(intent.industries, ["Manufacturing"]);
  assert.equal(intent.ambiguities.length, 0, "Food Manufacturing sí archiva bajo una Industry real — sin ambigüedad de bucket");
  assert.equal(intent.confidence, 1);
});

test("beverage manufacturing: 'Busca fábricas de bebidas.' (con acento, normalizado)", () => {
  const intent = interpret("Busca fábricas de bebidas.");
  assert.ok(intent.matchedTaxonomyKeys.includes("beverage_manufacturing"));
  assert.ok(intent.industries.includes("Manufacturing"));
});

test("packaging: 'Busca empresas de empaques.'", () => {
  const intent = interpret("Busca empresas de empaques.");
  assert.ok(intent.matchedTaxonomyKeys.includes("packaging"));
  assert.ok(intent.industries.includes("Manufacturing"));
});

test("warehouses: 'Busca warehouses con Forklift Operators.' (plurales en inglés)", () => {
  const intent = interpret("Busca warehouses con Forklift Operators.");
  assert.ok(intent.matchedTaxonomyKeys.includes("warehousing"));
  assert.deepEqual(intent.industries, ["Warehouse/Logistics"]);
  assert.ok(intent.targetJobTitles.includes("Forklift Operator"), "debe reconocer el plural 'Operators' contra el singular de la taxonomía");
});

test("janitorial: 'Busca empresas de janitorial services en Chicago.'", () => {
  const intent = interpret("Busca empresas de janitorial services en Chicago.");
  assert.ok(intent.matchedTaxonomyKeys.includes("janitorial"));
  assert.equal(intent.industries.length, 0);
  assert.ok(intent.preferredCities.includes("Chicago"));
});

test("roofing: 'Busca roofing contractors.'", () => {
  const intent = interpret("Busca roofing contractors.");
  assert.ok(intent.matchedTaxonomyKeys.includes("roofing"));
  assert.deepEqual(intent.industries, ["Construction"]);
});

test("restaurants: 'Busca restaurantes que necesiten Dishwashers.' (plural)", () => {
  const intent = interpret("Busca restaurantes que necesiten Dishwashers.");
  assert.ok(intent.matchedTaxonomyKeys.includes("restaurants"));
  assert.equal(intent.industries.length, 0);
  assert.ok(intent.targetJobTitles.includes("Dishwasher"));
});

test("data centers: 'Busca data centers que necesiten electricistas.' (título en español)", () => {
  const intent = interpret("Busca data centers que necesiten electricistas.");
  assert.ok(intent.matchedTaxonomyKeys.includes("data_centers"));
  assert.deepEqual(intent.industries, ["Construction"]);
  assert.ok(intent.targetJobTitles.includes("Electricista"));
});

test("landscaping: 'Busca empresas de landscaping.'", () => {
  const intent = interpret("Busca empresas de landscaping.");
  assert.ok(intent.matchedTaxonomyKeys.includes("landscaping"));
  assert.equal(intent.industries.length, 0);
});

test("plantas industriales: 'Busca plantas industriales que necesiten Maintenance Technicians.' (doble plural en español + plural en inglés)", () => {
  const intent = interpret("Busca plantas industriales que necesiten Maintenance Technicians.");
  assert.ok(intent.matchedTaxonomyKeys.includes("manufacturing"));
  assert.ok(intent.targetJobTitles.includes("Maintenance Technician"));
});

test("machine operators sin tipo de empresa: 'Busca empresas que contraten Machine Operators.'", () => {
  const intent = interpret("Busca empresas que contraten Machine Operators.");
  assert.equal(intent.companyTypes.length, 0);
  assert.equal(intent.industries.length, 0);
  assert.ok(intent.targetJobTitles.includes("Machine Operator"));
  assert.equal(intent.objective.type, "find_hiring_signals");
  assert.deepEqual(intent.plannedSteps, ["find_hiring_signals"]);
});

test("production workers sin tipo de empresa: 'Busca empresas que contraten Production Workers.'", () => {
  const intent = interpret("Busca empresas que contraten Production Workers.");
  assert.ok(intent.targetJobTitles.includes("Production Worker"));
  assert.equal(intent.objective.type, "find_hiring_signals");
});

test("exclusión simple: 'Busca hoteles pero excluye staffing.'", () => {
  const intent = interpret("Busca hoteles pero excluye staffing.");
  assert.ok(intent.companyTypes.includes("hotel"));
  assert.ok(intent.exclusions.includes("staffing"));
});

test("múltiples exclusiones separadas por coma y 'y': 'Busca fábricas de alimentos. Excluye construcción, electricidad, HVAC y staffing.'", () => {
  const intent = interpret("Busca fábricas de alimentos. Excluye construcción, electricidad, HVAC y staffing.");
  assert.ok(intent.matchedTaxonomyKeys.includes("food_manufacturing"));
  assert.deepEqual(intent.exclusions.sort(), ["HVAC", "construcción", "electricidad", "staffing"].sort());
  // Regla no negociable: un término excluido nunca puede terminar como
  // companyType/industry positivo -- "construcción" es sinónimo real de
  // la entrada "construction", pero al estar dentro de la cláusula de
  // exclusión, nunca debe activar esa entrada.
  assert.ok(!intent.matchedTaxonomyKeys.includes("construction"));
  assert.ok(!intent.matchedTaxonomyKeys.includes("electrical"));
});

test("múltiples ciudades con inferencia de estado: 'Busca manufactura en Chicago y Aurora.'", () => {
  const intent = interpret("Busca manufactura en Chicago y Aurora.");
  assert.ok(intent.matchedTaxonomyKeys.includes("manufacturing"));
  assert.deepEqual(intent.preferredCities.sort(), ["Aurora", "Chicago"].sort());
  assert.deepEqual(intent.states, ["IL"]);
});

test("roles sin tipo de empresa: 'Encuentra HR Manager o Plant Manager.'", () => {
  const intent = interpret("Encuentra HR Manager o Plant Manager.");
  assert.equal(intent.companyTypes.length, 0);
  assert.ok(intent.decisionRoles.includes("HR Manager"));
  assert.ok(intent.decisionRoles.includes("Plant Manager"));
  assert.equal(intent.objective.type, "find_contacts");
  assert.deepEqual(intent.plannedSteps, ["find_contacts", "find_organizational_emails", "verify_emails"]);
});

// Nota: "No crear campañas ni oportunidades" (con "ni") NO dispara
// NO_OPPORTUNITY_RE de packages/agents/src/tools/mission-restrictions.ts
// -- ese regex exige "crear ... oportunidad(es)" adyacente, un gap real
// y preexistente del detector ya shippeado en F4, documentado en la
// entrega de F7.1 (fuera de alcance tocar ese archivo acá). Se usan
// oraciones separadas, que sí matchea, para no depender de un fix no
// autorizado en este momento.
test("restricciones: 'Busca hoteles. No crear campañas. No crear oportunidades. No enviar correos.'", () => {
  const intent = interpret("Busca hoteles. No crear campañas. No crear oportunidades. No enviar correos.");
  assert.equal(intent.restrictions.allowCampaignCreation, false);
  assert.equal(intent.restrictions.allowOpportunityCreation, false);
  assert.equal(intent.restrictions.allowOutreach, false);
  assert.equal(intent.restrictions.allowMessageSending, false);
});

test("restricciones por default: una instrucción sin ninguna restricción explícita deja los 4 flags en true", () => {
  const intent = interpret("Busca hoteles en Illinois.");
  assert.equal(intent.restrictions.allowCampaignCreation, true);
  assert.equal(intent.restrictions.allowOpportunityCreation, true);
  assert.equal(intent.restrictions.allowOutreach, true);
  assert.equal(intent.restrictions.allowMessageSending, true);
});

test("ambigüedad total: una instrucción que no matchea ninguna entrada de la taxonomía ni ningún rol/título", () => {
  const intent = interpret("Busca proveedores de software empresarial.");
  assert.equal(intent.companyTypes.length, 0);
  assert.equal(intent.targetJobTitles.length, 0);
  assert.equal(intent.decisionRoles.length, 0);
  assert.equal(intent.confidence, 0.1);
  assert.ok(intent.ambiguities.some((a) => a.includes("no matcheó ninguna entrada")));
  assert.equal(intent.objective.type, "custom");
});

test("sinónimos: 'manufactura' (español) y 'manufacturing' (inglés) activan la misma entrada de taxonomía", () => {
  const es = interpret("Busca empresas de manufactura.");
  const en = interpret("Busca manufacturing companies.");
  assert.ok(es.matchedTaxonomyKeys.includes("manufacturing"));
  assert.ok(en.matchedTaxonomyKeys.includes("manufacturing"));
  assert.deepEqual(es.industries, en.industries);
});

test("determinismo: la misma instrucción produce siempre el mismo StructuredIntent", () => {
  const a = interpretBusinessIntent("Busca hoteles que necesiten housekeeping en Chicago.");
  const b = interpretBusinessIntent("Busca hoteles que necesiten housekeeping en Chicago.");
  assert.deepEqual(a, b);
});

test("cero llamadas externas, cero DB: interpretBusinessIntent es una función pura (mismo input siempre mismo output, sin async)", () => {
  const result = interpretBusinessIntent("Busca hoteles.");
  assert.equal(typeof (result as unknown as Promise<unknown>).then, "undefined", "no debe devolver una Promise");
});
