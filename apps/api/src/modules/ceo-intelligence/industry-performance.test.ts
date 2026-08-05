import { test } from "node:test";
import assert from "node:assert/strict";
import { rankIndustriesByPerformance, type IndustryMissionSample } from "./industry-performance";
import type { CommercialMetricsInput } from "./commercial-metrics";

function metricsInput(overrides: Partial<CommercialMetricsInput> = {}): CommercialMetricsInput {
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

// F34: reproduce el hallazgo real de la auditoría -- Janitorial (mejor
// retorno, $0.0074/lead) vs. Hospitality (peor retorno, $0.208/lead).
test("regresión real: Janitorial (mejor costo por lead) se ordena ANTES que Hospitality (peor costo por lead) al ordenar por costPerLead", () => {
  const samples: IndustryMissionSample[] = [
    { industryName: "Hospitality", missionId: "m1", metrics: metricsInput({ leadsCreated: 4, costUsd: 0.832 }) },
    { industryName: "Janitorial", missionId: "m2", metrics: metricsInput({ leadsCreated: 26, costUsd: 0.193 }) },
  ];
  const ranked = rankIndustriesByPerformance(samples, "costPerLead");
  assert.equal(ranked[0]!.industryName, "Janitorial");
  assert.equal(ranked[1]!.industryName, "Hospitality");
});

test("agrupa múltiples misiones de la MISMA industria antes de rankear (suma real, nunca una fila por misión)", () => {
  const samples: IndustryMissionSample[] = [
    { industryName: "Janitorial", missionId: "m1", metrics: metricsInput({ rawResults: 100, acceptedResults: 50 }) },
    { industryName: "Janitorial", missionId: "m2", metrics: metricsInput({ rawResults: 50, acceptedResults: 10 }) },
  ];
  const ranked = rankIndustriesByPerformance(samples, "noveltyRate");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.missionCount, 2);
  assert.equal(ranked[0]!.metrics.noveltyRate, Number((60 / 150).toFixed(4)));
});

test("una tasa donde MÁS ALTO es mejor (leadRate) ordena descendente", () => {
  const samples: IndustryMissionSample[] = [
    { industryName: "Low", missionId: "m1", metrics: metricsInput({ companiesCreated: 100, leadsCreated: 5 }) },
    { industryName: "High", missionId: "m2", metrics: metricsInput({ companiesCreated: 100, leadsCreated: 50 }) },
  ];
  const ranked = rankIndustriesByPerformance(samples, "leadRate");
  assert.equal(ranked[0]!.industryName, "High");
});

test("una industria sin ningún dato real para la métrica pedida queda SIEMPRE al final, nunca se asume mejor ni peor", () => {
  const samples: IndustryMissionSample[] = [
    { industryName: "NoData", missionId: "m1", metrics: metricsInput() }, // 0/0 -> null
    { industryName: "HasData", missionId: "m2", metrics: metricsInput({ companiesCreated: 10, leadsCreated: 5 }) },
  ];
  const ranked = rankIndustriesByPerformance(samples, "leadRate");
  assert.equal(ranked[0]!.industryName, "HasData");
  assert.equal(ranked[1]!.industryName, "NoData");
  assert.equal(ranked[1]!.metrics.leadRate, null);
});

test("sin ninguna muestra -> lista vacía, nunca inventa una industria", () => {
  assert.deepEqual(rankIndustriesByPerformance([], "leadRate"), []);
});

test("determinismo: mismo input siempre produce el mismo resultado", () => {
  const samples: IndustryMissionSample[] = [{ industryName: "Roofing", missionId: "m1", metrics: metricsInput({ leadsCreated: 3, costUsd: 0.5 }) }];
  assert.deepEqual(rankIndustriesByPerformance(samples, "costPerLead"), rankIndustriesByPerformance(samples, "costPerLead"));
});
