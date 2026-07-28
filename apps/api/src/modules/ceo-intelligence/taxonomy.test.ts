import { test } from "node:test";
import assert from "node:assert/strict";
import { businessTaxonomyEntrySchema } from "./contracts";
import { BUSINESS_TAXONOMY, getTaxonomyEntry } from "./taxonomy";

const REQUIRED_KEYS = [
  "hospitality",
  "manufacturing",
  "food_manufacturing",
  "beverage_manufacturing",
  "packaging",
  "warehousing",
  "distribution",
  "healthcare",
  "janitorial",
  "commercial_cleaning",
  "construction",
  "roofing",
  "electrical",
  "industrial_automation",
  "data_centers",
  "mission_critical",
  "landscaping",
  "restaurants",
  "retail",
  "transportation",
];

test("la taxonomía cubre exactamente las 20 categorías pedidas por el PO", () => {
  const keys = BUSINESS_TAXONOMY.map((e) => e.key).sort();
  assert.deepEqual(keys, [...REQUIRED_KEYS].sort());
});

test("cada entrada de la taxonomía valida contra su propio schema Zod", () => {
  for (const entry of BUSINESS_TAXONOMY) {
    const result = businessTaxonomyEntrySchema.safeParse(entry);
    assert.ok(result.success, `entrada "${entry.key}" inválida: ${JSON.stringify(result.error?.format())}`);
  }
});

test("ninguna key se repite", () => {
  const keys = BUSINESS_TAXONOMY.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("cada relatedIndustries apunta a una key real de la taxonomía (nunca una industria inventada)", () => {
  const realKeys = new Set(BUSINESS_TAXONOMY.map((e) => e.key));
  for (const entry of BUSINESS_TAXONOMY) {
    for (const related of entry.relatedIndustries) {
      assert.ok(realKeys.has(related), `"${entry.key}".relatedIndustries incluye "${related}", que no existe`);
    }
  }
});

test("getTaxonomyEntry devuelve la entrada real por key, y undefined para una key inexistente", () => {
  assert.equal(getTaxonomyEntry("hospitality")?.label, "Hospitality (Hotels & Resorts)");
  assert.equal(getTaxonomyEntry("no-existe"), undefined);
});

test("crmIndustryBucket, cuando no es null, es una de las 6 Industry reales del CRM (Construction/Warehouse-Logistics/Manufacturing/General Labor/Hospitality/Landscaping & Lawn Care)", () => {
  const REAL_INDUSTRIES = new Set(["Construction", "Warehouse/Logistics", "Manufacturing", "General Labor", "Hospitality", "Landscaping & Lawn Care"]);
  for (const entry of BUSINESS_TAXONOMY) {
    if (entry.crmIndustryBucket !== null) {
      assert.ok(
        REAL_INDUSTRIES.has(entry.crmIndustryBucket),
        `"${entry.key}".crmIndustryBucket="${entry.crmIndustryBucket}" no es una Industry real del CRM`,
      );
    }
  }
});

// F13 (auditoría PO, 2026-07-19): hospitality ahora SÍ tiene bucket real
// ("Hospitality", packages/db/prisma/seed.ts) -- antes quedaba sin
// bucket y cualquier candidato real de hoteles se rechazaba al
// persistir ("Sin bucket de Industry real aprobado"), aunque el
// descubrimiento externo (Google Places) sí los encontraba. F28 (misión
// real 2026-07-27/28, decisión explícita del PO 2026-07-28): landscaping
// tuvo exactamente el mismo problema real -- ahora también tiene bucket
// real, se saca de esta lista.
test("healthcare/janitorial/commercial_cleaning/restaurants/retail quedan sin bucket real (interpretación conservadora, no se inventa una industria)", () => {
  const expectedNull = ["healthcare", "janitorial", "commercial_cleaning", "restaurants", "retail"];
  for (const key of expectedNull) {
    assert.equal(getTaxonomyEntry(key)?.crmIndustryBucket, null, `"${key}" debería tener crmIndustryBucket=null`);
  }
});

test("hospitality tiene bucket real (Hospitality) -- F13, antes null", () => {
  assert.equal(getTaxonomyEntry("hospitality")?.crmIndustryBucket, "Hospitality");
});

test("landscaping tiene bucket real (Landscaping & Lawn Care) -- F28, antes null", () => {
  assert.equal(getTaxonomyEntry("landscaping")?.crmIndustryBucket, "Landscaping & Lawn Care");
});

// F28 (misión real de Hospitality, 2026-07-28, pedido explícito del PO):
// "busca hoteles" debe priorizar hoteles comerciales (Hotels/Resorts/
// Conference Hotels/Extended Stay/cadenas) -- googleSearchPhrases corre
// en orden real (mission-planner.ts/mission-executor.ts) y el cupo de la
// misión corta apenas se alcanza, así que el orden decide qué se termina
// aceptando. B&B/guest house/inn chico nunca se excluyen (siguen siendo
// hospitality real), solo quedan al final.
test("hospitality: googleSearchPhrases prioriza hoteles comerciales -- 'hotel'/'resort'/'conference hotel'/'extended stay hotel'/'hotel chain' van ANTES que 'bed and breakfast'", () => {
  const phrases = getTaxonomyEntry("hospitality")!.googleSearchPhrases;
  const commercialTerms = ["hotel", "resort", "conference hotel", "extended stay hotel", "hotel chain"];
  const bnbIndex = phrases.indexOf("bed and breakfast");
  assert.ok(bnbIndex !== -1, "'bed and breakfast' debe seguir presente -- nunca se excluye, solo se despriorizado");
  for (const term of commercialTerms) {
    const idx = phrases.indexOf(term);
    assert.ok(idx !== -1, `"${term}" debería estar en googleSearchPhrases`);
    assert.ok(idx < bnbIndex, `"${term}" (índice ${idx}) debería ir antes que "bed and breakfast" (índice ${bnbIndex})`);
  }
});

test("hospitality: reconoce explícitamente Conference Hotel, Extended Stay y cadenas (companyTypes + synonyms) -- categorías pedidas por el PO que antes no existían", () => {
  const entry = getTaxonomyEntry("hospitality")!;
  for (const term of ["conference hotel", "extended stay", "extended stay hotel", "hotel chain", "hotel group"]) {
    assert.ok(entry.synonyms.includes(term), `synonyms debería incluir "${term}"`);
    assert.ok(entry.companyTypes.includes(term) || term === "extended stay", `companyTypes debería incluir "${term}"`);
  }
});

test("hospitality: Bed & Breakfast, Guest House e Inn siguen siendo hospitality real -- despriorizados, nunca excluidos", () => {
  const entry = getTaxonomyEntry("hospitality")!;
  for (const term of ["bed and breakfast", "inn", "guest house"]) {
    assert.ok(entry.synonyms.includes(term), `synonyms debería seguir incluyendo "${term}"`);
  }
});
