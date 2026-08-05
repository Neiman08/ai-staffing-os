import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMissionConsistency, type MissionConsistencyInput } from "./mission-consistency";

function baseInput(overrides: Partial<MissionConsistencyInput> = {}): MissionConsistencyInput {
  return {
    requestedTaxonomyKeys: [],
    requestedLiteralTerms: [],
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

test("sin ninguna empresa seleccionada -- nunca marca INDUSTRY_MISMATCH (0 empresas no es lo mismo que 'empresas de otra industria', incluye el caso legítimo de CRM-reuse sin campaña -- ver nota de diseño del módulo)", () => {
  const result = evaluateMissionConsistency(baseInput({ requestedTaxonomyKeys: ["roofing"], selectedCompanies: [] }));
  assert.equal(result.consistent, true);
  assert.equal(result.matchedCompanyCount, 0);
  assert.equal(result.mismatchedCompanyCount, 0);
});

// F34 (fix real post-producción, hallazgo MIS-20260805-0005, Food
// Processing, 2026-08-05): Company.tradeKey solo se puebla cuando
// businessConfidence !== "WEAK" (mission-executor.ts, F19 Fase 1) -- si el
// llamador (mission-orchestrator.ts::closeMission) pasara ese tradeKey
// directamente, una misión donde TODAS las empresas coincidieron con el
// término pedido pero con evidencia débil terminaría con taxonomyKey=null
// para todas -> INDUSTRY_MISMATCH falso, aunque sí coincidían al momento
// de la query real. Este test documenta el contrato que el llamador debe
// cumplir: usar el taxonomyKey REAL de companyValidations (sin gating por
// confianza), nunca Company.tradeKey directo, para empresas recién
// descubiertas en ESTA misión.
test("empresas con evidencia SOLO débil (WEAK, tradeKey nunca poblado) pero que sí coincidieron con el término pedido al momento de la query -- taxonomyKey=null (simulando pasar Company.tradeKey directo) SÍ dispara INDUSTRY_MISMATCH; taxonomyKey='literal:<término>' (el valor real de companyValidations) NO", () => {
  const asIfCallerUsedGatedTradeKey = evaluateMissionConsistency(
    baseInput({
      requestedLiteralTerms: ["procesamiento de alimentos"],
      selectedCompanies: [
        { companyId: "c1", taxonomyKey: null },
        { companyId: "c2", taxonomyKey: null },
        { companyId: "c3", taxonomyKey: null },
      ],
    }),
  );
  assert.equal(asIfCallerUsedGatedTradeKey.consistent, false);

  const asIfCallerUsedMatchTimeTaxonomyKey = evaluateMissionConsistency(
    baseInput({
      requestedLiteralTerms: ["procesamiento de alimentos"],
      selectedCompanies: [
        { companyId: "c1", taxonomyKey: "literal:procesamiento de alimentos" },
        { companyId: "c2", taxonomyKey: "literal:procesamiento de alimentos" },
        { companyId: "c3", taxonomyKey: "literal:procesamiento de alimentos" },
      ],
    }),
  );
  assert.equal(asIfCallerUsedMatchTimeTaxonomyKey.consistent, true);
  assert.equal(asIfCallerUsedMatchTimeTaxonomyKey.matchedCompanyCount, 3);
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = baseInput({ requestedTaxonomyKeys: ["roofing"], selectedCompanies: [{ companyId: "c1", taxonomyKey: "construction" }] });
  assert.deepEqual(evaluateMissionConsistency(input), evaluateMissionConsistency(input));
});
