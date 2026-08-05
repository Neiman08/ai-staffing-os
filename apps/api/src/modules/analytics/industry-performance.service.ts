/**
 * F34 (auditoría arquitectónica transversal, 2026-08-05): "implementa
 * soporte para priorizar industrias según datos reales... demostrar, no
 * asumir, el rendimiento" -- capa de datos real sobre
 * ceo-intelligence/industry-performance.ts (puro). Este archivo es el
 * ÚNICO punto que toca Prisma: lee AgentTask (daily_revenue_mission,
 * DONE) reales y extrae CommercialMetricsInput de donde ya se calculó
 * (mission-executor.ts, DiscoveryExecutionReport.commercialMetrics) --
 * nunca recalcula ni inventa un número nuevo.
 *
 * Una misión que nunca ejecutó descubrimiento real (ej. CRM-reuse puro,
 * sin discover_companies) simplemente no aporta ninguna muestra -- nunca
 * se rellena con ceros, que falsearía su rendimiento real como "cero
 * resultados" en vez de "sin dato".
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { rankIndustriesByPerformance, type IndustryMissionSample, type IndustryPerformanceEntry } from "../ceo-intelligence/industry-performance";
import type { CommercialMetricsInput, CommercialMetricsResult } from "../ceo-intelligence/commercial-metrics";

const DEFAULT_SORT_BY: keyof CommercialMetricsResult = "costPerOpportunity";

function extractCommercialMetricsInput(output: unknown): CommercialMetricsInput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { discoveryExecution?: { commercialMetrics?: unknown }; discoveryFallback?: { commercialMetrics?: unknown } };
  const raw = o.discoveryExecution?.commercialMetrics ?? o.discoveryFallback?.commercialMetrics;
  // F34: commercialMetrics guardado es el RESULTADO (rates), no el input
  // crudo -- para agregar de verdad por industria (sumar conteos antes
  // de calcular ratios, ver aggregateCommercialMetrics) se necesitan los
  // conteos crudos, no las tasas ya calculadas. Se leen directamente los
  // campos crudos que mission-executor.ts sí persiste en el mismo
  // objeto (discoveryExecution/discoveryFallback), nunca inventados.
  if (!raw) return null;
  const report = (o.discoveryExecution ?? o.discoveryFallback) as Record<string, unknown> | undefined;
  if (!report) return null;
  const companyValidations = (report.companyValidations as Array<{ businessConfidence?: string }> | undefined) ?? [];
  return {
    rawResults: Number(report.rawResults ?? 0),
    acceptedResults: Number(report.acceptedResults ?? 0),
    duplicatesWithinMission: Number(report.duplicatesWithinMission ?? 0),
    duplicatesAlreadyInCrm: Number(report.duplicatesAlreadyInCrm ?? 0),
    companiesCreated: Number(report.companiesCreated ?? 0),
    validatedCompanies: companyValidations.filter((c) => c.businessConfidence !== "WEAK" && c.businessConfidence !== "REJECTED").length,
    companiesConsidered: Number(report.companiesCreated ?? 0),
    companiesWithContactPoint: Number(report.companiesEnriched ?? 0),
    emailsFound: Number(report.emailsExtracted ?? 0),
    emailsVerified: Number(report.emailsVerified ?? 0),
    leadsCreated: Number(report.leadsCreated ?? 0),
    opportunitiesCreated: Number(report.opportunitiesCreated ?? 0),
    draftsCreated: Number(report.draftsCreated ?? 0),
    // F34: esta capa no cruza contra EmailMessage todavía -- nunca 0 fabricado.
    emailsSent: null,
    emailsDelivered: null,
    hardBounces: null,
    spamBlocked: null,
    repliesReceived: null,
    meetingsBooked: null,
    costUsd: Number(report.costUsd ?? 0),
  };
}

export async function getIndustryPerformance(sortBy?: string): Promise<{ generatedAt: string; sortedBy: keyof CommercialMetricsResult; industries: IndustryPerformanceEntry[]; missionsWithoutData: number }> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const validSortKeys: Array<keyof CommercialMetricsResult> = [
    "noveltyRate",
    "duplicateRate",
    "validatedCompanyRate",
    "contactCoverageRate",
    "emailCoverageRate",
    "verifiedEmailRate",
    "leadRate",
    "opportunityRate",
    "draftRate",
    "costPerValidatedCompany",
    "costPerLead",
    "costPerOpportunity",
  ];
  const resolvedSortBy = validSortKeys.includes(sortBy as never) ? (sortBy as keyof CommercialMetricsResult) : DEFAULT_SORT_BY;

  const missions = await scopedDb.agentTask.findMany({
    where: { type: "daily_revenue_mission", status: "DONE" },
    select: { id: true, input: true, output: true },
  });

  const samples: IndustryMissionSample[] = [];
  let missionsWithoutData = 0;
  for (const mission of missions) {
    const input = (mission.input ?? {}) as { industryNames?: string[] };
    const industryName = input.industryNames?.[0]?.trim();
    const metrics = extractCommercialMetricsInput(mission.output);
    if (!industryName || !metrics) {
      missionsWithoutData += 1;
      continue;
    }
    samples.push({ industryName, missionId: mission.id, metrics });
  }

  return {
    generatedAt: new Date().toISOString(),
    sortedBy: resolvedSortBy,
    industries: rankIndustriesByPerformance(samples, resolvedSortBy),
    missionsWithoutData,
  };
}
