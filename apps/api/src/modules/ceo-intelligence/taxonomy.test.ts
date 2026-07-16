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

test("crmIndustryBucket, cuando no es null, es una de las 4 Industry reales del CRM (Construction/Warehouse-Logistics/Manufacturing/General Labor)", () => {
  const REAL_INDUSTRIES = new Set(["Construction", "Warehouse/Logistics", "Manufacturing", "General Labor"]);
  for (const entry of BUSINESS_TAXONOMY) {
    if (entry.crmIndustryBucket !== null) {
      assert.ok(
        REAL_INDUSTRIES.has(entry.crmIndustryBucket),
        `"${entry.key}".crmIndustryBucket="${entry.crmIndustryBucket}" no es una Industry real del CRM`,
      );
    }
  }
});

test("hospitality/healthcare/janitorial/commercial_cleaning/landscaping/restaurants/retail quedan sin bucket real (interpretación conservadora, no se inventa una industria)", () => {
  const expectedNull = [
    "hospitality",
    "healthcare",
    "janitorial",
    "commercial_cleaning",
    "landscaping",
    "restaurants",
    "retail",
  ];
  for (const key of expectedNull) {
    assert.equal(getTaxonomyEntry(key)?.crmIndustryBucket, null, `"${key}" debería tener crmIndustryBucket=null`);
  }
});
