import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCommercialMetrics, aggregateCommercialMetrics, type CommercialMetricsInput } from "./commercial-metrics";

function baseInput(overrides: Partial<CommercialMetricsInput> = {}): CommercialMetricsInput {
  return {
    rawResults: 0,
    acceptedResults: 0,
    duplicatesWithinMission: 0,
    duplicatesAlreadyInCrm: 0,
    companiesCreated: 0,
    validatedCompanies: 0,
    companiesConsidered: 0,
    companiesWithContactPoint: 0,
    emailsFound: 0,
    emailsVerified: 0,
    leadsCreated: 0,
    opportunitiesCreated: 0,
    draftsCreated: 0,
    emailsSent: null,
    emailsDelivered: null,
    hardBounces: null,
    spamBlocked: null,
    repliesReceived: null,
    meetingsBooked: null,
    costUsd: 0,
    ...overrides,
  };
}

// F34: reproduce los números reales de la auditoría (10 misiones,
// 1113 resultados crudos, 800 duplicados, 114 aceptados) para validar
// que las fórmulas coinciden con lo reportado manualmente.
test("regresión real: ratios de la auditoría (1113 crudos, 800 duplicados, 114 aceptados)", () => {
  const result = computeCommercialMetrics(
    baseInput({ rawResults: 1113, acceptedResults: 114, duplicatesWithinMission: 800, duplicatesAlreadyInCrm: 0 }),
  );
  assert.equal(result.noveltyRate, Number((114 / 1113).toFixed(4)));
  assert.equal(result.duplicateRate, Number((800 / 1113).toFixed(4)));
});

test("todas las tasas son null cuando el denominador es 0 -- nunca división por cero, nunca un 0 fabricado", () => {
  const result = computeCommercialMetrics(baseInput());
  assert.equal(result.noveltyRate, null);
  assert.equal(result.duplicateRate, null);
  assert.equal(result.validatedCompanyRate, null);
  assert.equal(result.contactCoverageRate, null);
  assert.equal(result.leadRate, null);
  assert.equal(result.opportunityRate, null);
  assert.equal(result.draftRate, null);
  assert.equal(result.costPerValidatedCompany, null);
});

// F34: invariante explícita del usuario -- "no inventes aperturas ni
// respuestas si el proveedor no las suministra".
test("regresión: reply/meeting/sent/delivered/hardBounce/spamBlocked quedan null cuando no hay dato real -- NUNCA se reportan como 0", () => {
  const result = computeCommercialMetrics(baseInput({ companiesCreated: 10, leadsCreated: 5 }));
  assert.equal(result.replyRate, null, "replyRate debe ser null (sin dato), nunca 0 (que afirmaría '0 respuestas medidas')");
  assert.equal(result.meetingRate, null);
  assert.equal(result.deliveredRate, null);
  assert.equal(result.hardBounceRate, null);
  assert.equal(result.spamBlockedRate, null);
  assert.equal(result.costPerReply, null);
  assert.equal(result.costPerMeeting, null);
});

test("con datos reales de envío, las tasas de sent/delivered/bounce/spam/reply/meeting se calculan correctamente", () => {
  const result = computeCommercialMetrics(
    baseInput({
      emailsSent: 82,
      emailsDelivered: 76,
      hardBounces: 4,
      spamBlocked: 2,
      repliesReceived: 3,
      meetingsBooked: 1,
      costUsd: 8.2,
    }),
  );
  assert.equal(result.deliveredRate, Number((76 / 82).toFixed(4)));
  assert.equal(result.hardBounceRate, Number((4 / 82).toFixed(4)));
  assert.equal(result.spamBlockedRate, Number((2 / 82).toFixed(4)));
  assert.equal(result.replyRate, Number((3 / 82).toFixed(4)));
  assert.equal(result.meetingRate, Number((1 / 82).toFixed(4)));
  assert.equal(result.costPerReply, Number((8.2 / 3).toFixed(4)));
  assert.equal(result.costPerMeeting, 8.2);
});

test("costo por empresa validada/lead/opportunity se calcula correctamente con datos reales", () => {
  const result = computeCommercialMetrics(
    baseInput({ validatedCompanies: 10, leadsCreated: 5, opportunitiesCreated: 2, costUsd: 1.0 }),
  );
  assert.equal(result.costPerValidatedCompany, 0.1);
  assert.equal(result.costPerLead, 0.2);
  assert.equal(result.costPerOpportunity, 0.5);
});

test("funnel completo: leadRate/opportunityRate/draftRate encadenados correctamente", () => {
  const result = computeCommercialMetrics(
    baseInput({ companiesCreated: 100, leadsCreated: 50, opportunitiesCreated: 20, draftsCreated: 15 }),
  );
  assert.equal(result.leadRate, 0.5);
  assert.equal(result.opportunityRate, 0.4);
  assert.equal(result.draftRate, 0.75);
});

// ---------- aggregateCommercialMetrics (por industria) ----------

test("aggregateCommercialMetrics: suma conteos ANTES de calcular ratios (nunca promedia ratios ya calculados)", () => {
  const mission1 = baseInput({ rawResults: 100, acceptedResults: 50 }); // 50% novedad
  const mission2 = baseInput({ rawResults: 10, acceptedResults: 1 }); // 10% novedad
  const result = aggregateCommercialMetrics([mission1, mission2]);
  // Promedio simple de ratios sería (50%+10%)/2=30% -- INCORRECTO. Suma
  // real: (50+1)/(100+10) = 51/110 ≈ 46.4%, mucho más cerca de la
  // muestra grande, que es lo correcto estadísticamente.
  assert.equal(result.noveltyRate, Number((51 / 110).toFixed(4)));
});

test("aggregateCommercialMetrics: sin misiones -> todo null, nunca 0/NaN", () => {
  const result = aggregateCommercialMetrics([]);
  assert.equal(result.noveltyRate, null);
  assert.equal(result.leadRate, null);
});

test("aggregateCommercialMetrics: si NINGUNA misión de la industria reportó datos de envío real, el agregado queda null -- nunca 0", () => {
  const result = aggregateCommercialMetrics([baseInput({ companiesCreated: 5 }), baseInput({ companiesCreated: 3 })]);
  assert.equal(result.replyRate, null);
  assert.equal(result.deliveredRate, null);
});

test("aggregateCommercialMetrics: si AL MENOS una misión reportó datos de envío real, se suman -- las que no reportaron no restan", () => {
  const result = aggregateCommercialMetrics([
    baseInput({ emailsSent: 10, emailsDelivered: 9 }),
    baseInput({ emailsSent: null, emailsDelivered: null }),
  ]);
  assert.equal(result.deliveredRate, Number((9 / 10).toFixed(4)));
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const input = baseInput({ rawResults: 20, acceptedResults: 5, companiesCreated: 5, leadsCreated: 2 });
  assert.deepEqual(computeCommercialMetrics(input), computeCommercialMetrics(input));
});
