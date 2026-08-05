import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMissionConsistency, type MissionConsistencyInput } from "./mission-consistency";

function baseInput(overrides: Partial<MissionConsistencyInput> = {}): MissionConsistencyInput {
  return {
    requestedTaxonomyKeys: [],
    requestedLiteralTerms: [],
    discoveryWasPlanned: false,
    queriesPlanned: 0,
    queriesExecuted: 0,
    selectedCompanies: [],
    ...overrides,
  };
}

// F34: reproduce EXACTAMENTE el hallazgo crítico real de MIS-20260805-0002
// -- 20 empresas seleccionadas (janitorial/landscaping/manufacturing),
// CERO relacionadas con los 4 términos literales pedidos
// (property/apartment/facility/building maintenance).
test("regresión CRÍTICA real MIS-20260805-0002: 20 empresas de industrias ajenas, 0 coincidencias -> INDUSTRY_MISMATCH, inconsistent=true", () => {
  const selectedCompanies = [
    ...Array.from({ length: 16 }, (_, i) => ({ companyId: `janitorial-${i}`, taxonomyKey: "janitorial" })),
    ...Array.from({ length: 3 }, (_, i) => ({ companyId: `landscaping-${i}`, taxonomyKey: "landscaping" })),
    { companyId: "manufacturing-1", taxonomyKey: "manufacturing" },
  ];
  const result = evaluateMissionConsistency(
    baseInput({
      requestedLiteralTerms: ["property maintenance", "apartment maintenance", "facility maintenance", "building maintenance"],
      selectedCompanies,
    }),
  );
  assert.equal(result.consistent, false);
  assert.equal(result.matchedCompanyCount, 0);
  assert.equal(result.mismatchedCompanyCount, 20);
  assert.ok(result.issues.some((i) => i.code === "INDUSTRY_MISMATCH"));
});

test("empresas que SÍ corresponden al término literal pedido (taxonomyKey='literal:<término>') -> consistent=true", () => {
  const result = evaluateMissionConsistency(
    baseInput({
      requestedLiteralTerms: ["property maintenance"],
      selectedCompanies: [
        { companyId: "c1", taxonomyKey: "literal:property maintenance" },
        { companyId: "c2", taxonomyKey: "literal:property maintenance" },
      ],
    }),
  );
  assert.equal(result.consistent, true);
  assert.equal(result.matchedCompanyCount, 2);
});

test("empresas que corresponden a un taxonomyKey real pedido (no literal) -> consistent=true", () => {
  const result = evaluateMissionConsistency(
    baseInput({
      requestedTaxonomyKeys: ["roofing"],
      selectedCompanies: [{ companyId: "c1", taxonomyKey: "roofing" }],
    }),
  );
  assert.equal(result.consistent, true);
});

test("mezcla parcial (algunas coinciden, otras no) -- consistent=true, nunca inconsistente por una mezcla parcial (otros mecanismos ya cubren eso)", () => {
  const result = evaluateMissionConsistency(
    baseInput({
      requestedTaxonomyKeys: ["roofing"],
      selectedCompanies: [
        { companyId: "c1", taxonomyKey: "roofing" },
        { companyId: "c2", taxonomyKey: "construction" },
      ],
    }),
  );
  assert.equal(result.consistent, true);
  assert.equal(result.matchedCompanyCount, 1);
  assert.equal(result.mismatchedCompanyCount, 1);
});

test("sin ningún rubro específico pedido (mission genuinamente amplia) -- nunca marca INDUSTRY_MISMATCH, sin importar qué empresas haya", () => {
  const result = evaluateMissionConsistency(
    baseInput({ selectedCompanies: [{ companyId: "c1", taxonomyKey: "janitorial" }, { companyId: "c2", taxonomyKey: null }] }),
  );
  assert.equal(result.consistent, true);
});

test("sin ninguna empresa seleccionada -- nunca marca INDUSTRY_MISMATCH (0 empresas no es lo mismo que 'empresas de otra industria')", () => {
  const result = evaluateMissionConsistency(baseInput({ requestedTaxonomyKeys: ["roofing"], selectedCompanies: [] }));
  assert.equal(result.consistent, true);
  assert.equal(result.matchedCompanyCount, 0);
  assert.equal(result.mismatchedCompanyCount, 0);
});

test("rubro específico pedido + discovery planificado pero nunca ejecutado (0 queries reales) -> DISCOVERY_PLANNED_BUT_NEVER_EXECUTED", () => {
  const result = evaluateMissionConsistency(
    baseInput({ requestedTaxonomyKeys: ["roofing"], discoveryWasPlanned: true, queriesPlanned: 4, queriesExecuted: 0 }),
  );
  assert.equal(result.consistent, false);
  assert.ok(result.issues.some((i) => i.code === "DISCOVERY_PLANNED_BUT_NEVER_EXECUTED"));
});

test("rubro específico pedido + discovery planificado y ejecutado -- consistent=true", () => {
  const result = evaluateMissionConsistency(
    baseInput({ requestedTaxonomyKeys: ["roofing"], discoveryWasPlanned: true, queriesPlanned: 4, queriesExecuted: 4 }),
  );
  assert.equal(result.consistent, true);
});

test("pedido GENÉRICO (sin rubro específico) + discovery planificado pero 0 queries ejecutadas -- consistent=true (oferta interna del CRM ya alcanzaba, comportamiento legítimo)", () => {
  const result = evaluateMissionConsistency(baseInput({ discoveryWasPlanned: true, queriesPlanned: 4, queriesExecuted: 0 }));
  assert.equal(result.consistent, true, "un pedido genérico con CRM suficiente nunca debe marcarse inconsistente por 0 queries ejecutadas");
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = baseInput({ requestedTaxonomyKeys: ["roofing"], selectedCompanies: [{ companyId: "c1", taxonomyKey: "construction" }] });
  assert.deepEqual(evaluateMissionConsistency(input), evaluateMissionConsistency(input));
});
