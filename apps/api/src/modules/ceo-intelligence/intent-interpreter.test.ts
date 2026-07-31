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
  // F13 (auditoría PO, 2026-07-19): Hospitality ahora SÍ tiene Industry
  // real en el CRM (antes esperaba 0 acá, con crmIndustryBucket=null) --
  // ver taxonomy.test.ts.
  assert.deepEqual(intent.industries, ["Hospitality"]);
  assert.ok(intent.hiringSignals.includes("Housekeeper"));
  assert.ok(intent.targetJobTitles.includes("Housekeeping"));
  assert.ok(intent.decisionRoles.includes("HR Manager"));
  assert.ok(intent.plannedSteps.includes("discover_companies"));
  assert.ok(intent.plannedSteps.includes("find_hiring_signals"));
  assert.ok(!intent.ambiguities.some((a) => a.includes("crmIndustryBucket")), "ya no debería haber ambigüedad de crmIndustryBucket para hospitality");
  assert.equal(intent.objective.type, "find_companies");
});

// F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
// "hoteles comerciales" excluye motel/inn/bed and breakfast/guest house
// de las queries por completo -- caso especial, acotado a hospitality.
test("hoteles comerciales: 'Busca hoteles comerciales en Illinois.' excluye motel/inn/bed and breakfast de las queries", () => {
  const intent = interpret("Busca hoteles comerciales en Illinois.");
  for (const term of ["motel", "inn", "bed and breakfast"]) {
    assert.ok(intent.exclusions.includes(term), `"${term}" debería estar en exclusions`);
  }
  assert.ok(intent.matchedTaxonomyKeys.includes("hospitality"));
});

test("commercial hotels (inglés): 'Find commercial hotels in Illinois.' también excluye", () => {
  const intent = interpret("Find commercial hotels in Illinois.");
  for (const term of ["motel", "inn", "bed and breakfast"]) {
    assert.ok(intent.exclusions.includes(term));
  }
});

test("'Busca hoteles en Illinois.' (sin 'comerciales') NUNCA excluye motel/inn/bed and breakfast -- caso normal, sin cambios", () => {
  const intent = interpret("Busca hoteles en Illinois.");
  for (const term of ["motel", "inn", "bed and breakfast"]) {
    assert.ok(!intent.exclusions.includes(term), `"${term}" no debería excluirse sin "hoteles comerciales" explícito`);
  }
});

test("una instrucción de OTRO trade (manufactura, sin ninguna mención de hoteles) nunca excluye motel/inn/bed and breakfast -- el gate está acotado a hospitality, no es una regla genérica", () => {
  const intent = interpret("Busca empresas de manufactura en Illinois.");
  assert.ok(!intent.matchedTaxonomyKeys.includes("hospitality"));
  for (const term of ["motel", "inn", "bed and breakfast"]) {
    assert.ok(!intent.exclusions.includes(term));
  }
});

test("'hoteles comerciales' respeta exclusiones explícitas adicionales de la instrucción (excluye: X) -- se combinan, nunca se pisan", () => {
  const intent = interpret("Busca hoteles comerciales en Illinois. Excluye: resort.");
  assert.ok(intent.exclusions.includes("resort"));
  assert.ok(intent.exclusions.includes("motel"));
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

// F29 (hallazgo real, MIS-20260729-0009, 2026-07-29): "Manufactura",
// "Centros de distribución", "Logística", "Warehouses" y "Healthcare no
// clínico" aparecían cada uno como su propio ítem explícito de la lista
// -- pero manufacturing/warehousing/distribution/healthcare son
// isGenericFallback=true en la taxonomía (F14: "bucket amplio, último
// recurso"), así que specificMatchedTaxonomyKeys los excluía como si
// nunca se hubieran pedido. La misión real terminó rechazando candidatos
// reales de "Manufacturing (General)" con el mensaje "la misión pidió
// específicamente: Hospitality, Food Manufacturing, Packaging,
// Janitorial, Commercial Cleaning" -- una mentira, dado que la
// instrucción sí pidió más categorías explícitamente.
test("misión multiindustria (caso real MIS-20260729-0009): Manufactura/Warehouses/Centros de distribución/Healthcare, cada uno su propio ítem explícito, SÍ cuentan como específicamente pedidos pese a ser isGenericFallback=true", () => {
  const intent = interpret(
    "Busca empresas en Illinois. Prioriza: * Manufactura * Centros de distribución * Logística * Warehouses * Food processing * Packaging * Hoteles * Limpieza comercial * Healthcare no clínico",
  );
  assert.ok(intent.matchedTaxonomyKeys.includes("manufacturing"));
  assert.ok(intent.matchedTaxonomyKeys.includes("warehousing"));
  assert.ok(intent.matchedTaxonomyKeys.includes("distribution"));
  assert.ok(intent.matchedTaxonomyKeys.includes("healthcare"));

  // El bug real: estas 4 quedaban afuera de specificMatchedTaxonomyKeys
  // pese a estar en su propio ítem explícito de la lista.
  assert.ok(intent.specificMatchedTaxonomyKeys.includes("manufacturing"), "Manufactura fue su propio ítem explícito -- debe contar como pedido específicamente");
  assert.ok(intent.specificMatchedTaxonomyKeys.includes("warehousing"), "Warehouses fue su propio ítem explícito -- debe contar como pedido específicamente");
  assert.ok(intent.specificMatchedTaxonomyKeys.includes("distribution"), "Centros de distribución/Logística fueron su propio ítem explícito -- debe contar como pedido específicamente");
  assert.ok(intent.specificMatchedTaxonomyKeys.includes("healthcare"), "Healthcare no clínico fue su propio ítem explícito -- debe contar como pedido específicamente");
});

// F28 (guardrail de regresión, roofing IL 2026-07-27): el fix de arriba
// NO debe reintroducir el bug original -- cuando "construction" solo
// matchea por una palabra ambigua/compartida ("contractor", también
// parte de "roofing contractor"), nunca debe contar como pedido
// específicamente. Si este test fallara, un candidato real de
// "Construction (General)" (ej. una constructora general sin ninguna
// evidencia de roofing) volvería a aceptarse en una misión que solo
// pidió roofing -- exactamente el bug de contaminación cruzada que F28
// corrigió.
test("guardrail F28: 'Busca roofing contractors en Illinois.' NUNCA trata 'construction' como pedido específicamente (match incidental vía 'contractor', subsumido por 'roofing contractor')", () => {
  const intent = interpret("Busca roofing contractors en Illinois.");
  assert.ok(intent.matchedTaxonomyKeys.includes("roofing"));
  assert.ok(intent.matchedTaxonomyKeys.includes("construction"), "construction matchea incidentalmente vía 'contractor' -- ese es justamente el caso a proteger");

  assert.ok(intent.specificMatchedTaxonomyKeys.includes("roofing"), "roofing sí fue pedido específicamente");
  assert.ok(
    !intent.specificMatchedTaxonomyKeys.includes("construction"),
    "construction NUNCA debe contar como pedido específicamente -- solo matcheó vía 'contractor', subsumido por el match más específico de roofing ('roofing contractor')",
  );
});

// F29: "producción industrial" faltaba en los sinónimos de manufacturing
// -- término real de una instrucción real que quedaba sin reconocer.
test("'Producción industrial' matchea manufacturing (sinónimo agregado, hallazgo real MIS-20260729-0009)", () => {
  const intent = interpret("Busca empresas de producción industrial en Illinois.");
  assert.ok(intent.matchedTaxonomyKeys.includes("manufacturing"));
  assert.ok(intent.specificMatchedTaxonomyKeys.includes("manufacturing"));
});

// F13 (auditoría PO, 2026-07-19): "contratistas eléctricos" (adjetivo)
// es la frase real que usó el PO al validar el descubrimiento externo --
// antes solo estaba la forma sustantivo ("electricistas") en los
// sinónimos, así que esta instrucción exacta nunca activaba "electrical"
// y caía al match genérico "construction" (buscaba "construction
// company" en vez de contratistas eléctricos reales, hallazgo real
// documentado en el commit de este fix).
test("electrical: 'Busca contratistas eléctricos reales en Texas.' (adjetivo en español, la frase real que reportó el PO)", () => {
  const intent = interpret("Busca contratistas eléctricos reales en Texas.");
  assert.ok(intent.matchedTaxonomyKeys.includes("electrical"), "debería matchear 'electrical' con la forma adjetivo en español");
  assert.deepEqual(intent.industries, ["Construction"]);
  assert.deepEqual(intent.states, ["TX"]);
});

test("electrical: 'Busca electrical contractors en Houston.' (inglés + ciudad de Texas sin nombrar el estado)", () => {
  const intent = interpret("Busca electrical contractors en Houston.");
  assert.ok(intent.matchedTaxonomyKeys.includes("electrical"));
  assert.deepEqual(intent.preferredCities, ["Houston"]);
  assert.deepEqual(intent.states, ["TX"]);
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
  // F28 (decisión explícita del PO, 2026-07-28): landscaping ahora tiene
  // bucket real ("Landscaping & Lawn Care", ver taxonomy.ts/seed.ts) --
  // antes era null y esta prueba fijaba ese comportamiento a propósito.
  assert.deepEqual(intent.industries, ["Landscaping & Lawn Care"]);
});

// F28 (misión real 2026-07-27): sinónimos ampliados pedidos explícitamente.
const LANDSCAPING_SYNONYM_INSTRUCTIONS = [
  "Busca empresas de lawn care en Illinois.",
  "Busca empresas de landscape maintenance en Illinois.",
  "Busca empresas de grounds maintenance en Illinois.",
  "Busca empresas de lawn maintenance en Illinois.",
  "Busca empresas de outdoor services en Illinois.",
  "Busca empresas landscape contractor en Illinois.",
  "Busca empresas de landscape management en Illinois.",
];
for (const instruction of LANDSCAPING_SYNONYM_INSTRUCTIONS) {
  test(`landscaping: reconoce sinónimo real -- "${instruction}"`, () => {
    const intent = interpret(instruction);
    assert.ok(intent.matchedTaxonomyKeys.includes("landscaping"), `no matcheó "landscaping" para: ${instruction}`);
  });
}

test("landscaping: 'snow and landscape services' (frase compuesta) SÍ matchea landscaping", () => {
  const intent = interpret("Busca empresas de snow and landscape services en Illinois.");
  assert.ok(intent.matchedTaxonomyKeys.includes("landscaping"));
});

test("landscaping: 'snow removal' solo (sin landscaping) NUNCA matchea landscaping -- pedido explícito: solo cuenta si la empresa también presta landscaping", () => {
  const intent = interpret("Busca empresas de snow removal en Illinois.");
  assert.ok(!intent.matchedTaxonomyKeys.includes("landscaping"), "snow removal solo no debe activar landscaping");
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

// ============================================================
// F32 (auditoría arquitectónica, hallazgo real MIS-20260731-0002/0003,
// 2026-07-31): una industria fuera de BUSINESS_TAXONOMY (HVAC,
// refrigeración comercial, servicios mecánicos) hacía que
// matchedTaxonomyKeys=[] -> hasCompanyContext=false -> el objetivo caía
// a find_contacts y discover_companies desaparecía del plan por
// completo, pese a que la instrucción decía explícitamente "Busca hasta
// 20 empresas nuevas... dedicadas a HVAC...". Estas pruebas cubren el
// caso general -- ninguna industria puntual queda hardcodeada como
// "arreglada", el mecanismo debe funcionar para CUALQUIER término
// desconocido.
// ============================================================

test("caso real MIS-20260731-0002: 'Busca hasta 20 empresas nuevas en Illinois dedicadas a HVAC, refrigeración comercial y servicios mecánicos...' -- objective=find_companies, discover_companies planificado, términos literales preservados", () => {
  const intent = interpret(
    "Busca hasta 20 empresas nuevas en Illinois dedicadas a HVAC, refrigeración comercial y servicios mecánicos que puedan necesitar servicios de staffing.",
  );
  assert.equal(intent.objective.type, "find_companies", "NUNCA debe degradar a find_contacts solo porque la taxonomía no reconoce el rubro");
  assert.ok(intent.plannedSteps.includes("discover_companies"), "discover_companies NUNCA debe desaparecer del plan por una industria desconocida");
  assert.deepEqual(intent.matchedTaxonomyKeys, [], "ninguna entrada de BUSINESS_TAXONOMY reconoce HVAC -- esto es justamente lo que se está probando");
  for (const term of ["HVAC", "refrigeración comercial", "servicios mecánicos"]) {
    assert.ok(intent.literalCompanyTypeTerms.includes(term), `"${term}" debe conservarse tal cual como criterio de búsqueda`);
  }
});

// Generativo/basado en propiedades: variaciones lingüísticas ES/EN sobre
// el MISMO mecanismo general -- nunca una rama especial por industria.
const UNKNOWN_INDUSTRY_INSTRUCTIONS = [
  "Busca empresas dedicadas a acuicultura comercial en Illinois.",
  "Encuentra compañías de reparación de drones industriales en Texas.",
  "Identifica negocios de fabricación de baterías de litio en Illinois.",
  "Find companies specializing in commercial drone repair in Illinois.",
  "Search for companies in the field of industrial battery recycling in Texas.",
  "Busca empresas de refrigeración comercial y servicios mecánicos en Illinois.",
];
for (const instruction of UNKNOWN_INDUSTRY_INSTRUCTIONS) {
  test(`industria genuinamente desconocida (sin rama especial por término) -- "${instruction}"`, () => {
    const intent = interpret(instruction);
    assert.equal(intent.objective.type, "find_companies", `debe seguir siendo find_companies para: ${instruction}`);
    assert.ok(intent.plannedSteps.includes("discover_companies"), `discover_companies debe seguir planificado para: ${instruction}`);
    assert.ok(intent.literalCompanyTypeTerms.length > 0, `debe extraer al menos un término literal para: ${instruction}`);
  });
}

test("modelProposedTerms (F32, puente con interpretDailyDirective/ceo-tools.impl.ts): términos propuestos por el modelo cuentan igual que la extracción determinista de respaldo", () => {
  const intent = interpretBusinessIntent("Busca empresas en Illinois que puedan necesitar staffing.", [
    "commercial refrigeration contractor",
    "mechanical services contractor",
  ]);
  assert.ok(intent.literalCompanyTypeTerms.includes("commercial refrigeration contractor"));
  assert.ok(intent.literalCompanyTypeTerms.includes("mechanical services contractor"));
  assert.equal(intent.objective.type, "find_companies");
  assert.ok(intent.plannedSteps.includes("discover_companies"));
});

test("modelProposedTerms: un término YA cubierto por un match real de taxonomía nunca se duplica en literalCompanyTypeTerms", () => {
  const intent = interpretBusinessIntent("Busca hoteles en Illinois.", ["hotel", "hospitality group"]);
  assert.deepEqual(intent.literalCompanyTypeTerms, [], "hotel/hospitality group ya están cubiertos por la entrada real 'hospitality' -- nunca duplicados como literales");
  assert.ok(intent.matchedTaxonomyKeys.includes("hospitality"));
});

// Caso real MIS-20260731-0003: roles/objetos/acciones NUNCA deben
// aparecer como "tipo de empresa desconocido" -- ver
// semantic-normalization.ts, única fuente de verdad compartida.
test("roles/objetos del CRM/acciones del pipeline nunca aparecen en literalCompanyTypeTerms, aunque el LLM los proponga por error", () => {
  const intent = interpretBusinessIntent(
    "Busca empresas nuevas en Illinois. Identifica a los responsables de contratación (Owner, Operations Manager, HR, Recruiting). Crea Company, Contact, Lead y Opportunity.",
    ["Owner", "Operations Manager", "HR", "Recruiting", "Opportunity", "Lead", "Contact", "Company"],
  );
  for (const term of ["Owner", "Operations Manager", "HR", "Recruiting", "Opportunity", "Lead", "Contact", "Company"]) {
    assert.ok(!intent.literalCompanyTypeTerms.includes(term), `"${term}" es un rol/objeto/acción -- nunca debe aparecer como tipo de empresa desconocido`);
  }
});

test("términos verdaderamente ambiguos (sin disparador de tipo de empresa) no se inventan como literalCompanyTypeTerms", () => {
  const intent = interpret("Busca proveedores de software empresarial.");
  assert.deepEqual(intent.literalCompanyTypeTerms, []);
  assert.equal(intent.objective.type, "custom", "sin ninguna señal real (ni taxonomía, ni término literal disparado, ni rol/título), sigue siendo ambigüedad genuina");
});

test("guardrail F32: 'Busca empresas que contraten Machine Operators.' (targetJobTitles real) NUNCA se pisa por el detector de verbo -- find_hiring_signals sigue ganando, más específico", () => {
  const intent = interpret("Busca empresas que contraten Machine Operators.");
  assert.equal(intent.objective.type, "find_hiring_signals");
  assert.deepEqual(intent.plannedSteps, ["find_hiring_signals"]);
});

test("guardrail F32: 'Encuentra HR Manager o Plant Manager.' (decisionRoles real) NUNCA se pisa por el detector de verbo -- find_contacts sigue ganando, más específico", () => {
  const intent = interpret("Encuentra HR Manager o Plant Manager.");
  assert.equal(intent.objective.type, "find_contacts");
});

// F32 (hallazgo real, MIS-20260731-0011, 2026-07-31 -- caso de
// producción real, industria genuinamente desconocida): "empresas
// NUEVAS de X" nunca disparaba COMPANY_TYPE_TRIGGER_RE -- el patrón
// exigía "empresas" seguido INMEDIATAMENTE de "de", pero el adjetivo
// "nuevas" (la forma más natural y común en instrucciones reales) se
// interpone entre ambos. Sin el LLM upstream (interpretDailyDirective
// solo llena externalSearchTerms cuando useExternalDiscovery=true, que
// esta instrucción nunca activó), este regex determinista era la ÚNICA
// red de seguridad real para el camino más común (fallback automático
// clásico) -- y tenía este hueco: la misión real terminó con
// literalCompanyTypeTerms=[], discover_companies NUNCA se ejecutó.
test("caso real MIS-20260731-0011: 'empresas NUEVAS de instalación de paneles solares comerciales en Illinois' -- el adjetivo entre 'empresas' y 'de' no debe romper la extracción, y el calificador geográfico final se recorta", () => {
  const intent = interpret(
    "Busca hasta 3 empresas nuevas de instalación de paneles solares comerciales en Illinois que puedan necesitar personal de campo.",
  );
  assert.deepEqual(intent.literalCompanyTypeTerms, ["instalación de paneles solares comerciales"]);
  assert.equal(intent.objective.type, "find_companies");
  assert.ok(intent.plannedSteps.includes("discover_companies"));
});

test("variantes del mismo hueco: 'compañías reales de X', 'negocios confiables de X' -- adjetivos distintos, mismo mecanismo general (nunca una lista cerrada de adjetivos conocidos)", () => {
  const a = interpret("Busca compañías reales de reparación de drones industriales en Illinois.");
  assert.ok(a.literalCompanyTypeTerms.some((t) => t.includes("reparación de drones industriales")));

  const b = interpret("Busca negocios confiables de fabricación de baterías de litio en Texas.");
  assert.ok(b.literalCompanyTypeTerms.some((t) => t.includes("fabricación de baterías de litio")));
});

test("el calificador geográfico se recorta también cuando el término termina justo antes de una ciudad conocida (nunca solo estados)", () => {
  const intent = interpret("Busca empresas nuevas de reparación de drones comerciales en Chicago.");
  assert.deepEqual(intent.literalCompanyTypeTerms, ["reparación de drones comerciales"]);
  assert.deepEqual(intent.preferredCities, ["Chicago"]);
});

// F32 (bugfix real encontrado ejecutando una prueba de integración con
// runMissionPipeline real, MIS-20260731-0011, 2026-07-31): "ciudad,
// estado" (con coma, ej. "en Decatur, Illinois") -- recortar el
// calificador geográfico DESPUÉS de dividir por comas (el separador de
// listas, "roofing, landscaping y HVAC") dejaba "Illinois" como su
// PROPIO término literal suelto (nunca coincidía con el patrón "en/in
// <lugar>" de trimTrailingLocation al evaluarse aislado) -- terminó
// generando una query real sin sentido en producción ("Illinois in
// Decatur, Illinois"). El recorte geográfico debe aplicarse sobre la
// cláusula COMPLETA, antes de partirla en items de lista.
test("caso real MIS-20260731-0011 (ciudad+estado con coma): 'en Decatur, Illinois' nunca dispersa 'Illinois' como su propio término literal suelto", () => {
  const intent = interpret(
    "Busca hasta 3 empresas nuevas de instalación de paneles solares comerciales en Decatur, Illinois que puedan necesitar personal de campo.",
  );
  assert.deepEqual(intent.literalCompanyTypeTerms, ["instalación de paneles solares comerciales"]);
  assert.ok(!intent.literalCompanyTypeTerms.includes("Illinois"), "Illinois nunca debe aparecer como su propio término literal");
  assert.deepEqual(intent.preferredCities, ["Decatur"]);
  assert.deepEqual(intent.states, ["IL"]);
});

test("recorte geográfico con coma NUNCA rompe una lista real de varios rubros (ej. 'roofing, HVAC y landscaping en Chicago')", () => {
  const intent = interpret("Busca empresas de landscaping, jardineria y paisajismo en Chicago.");
  // landscaping/jardineria/paisajismo ya matchean la taxonomía real --
  // esto solo confirma que la coma de la lista real sigue funcionando
  // como separador de items después del fix (nunca se confunde con la
  // coma de "ciudad, estado").
  assert.ok(intent.matchedTaxonomyKeys.includes("landscaping"));
  assert.deepEqual(intent.preferredCities, ["Chicago"]);
});
