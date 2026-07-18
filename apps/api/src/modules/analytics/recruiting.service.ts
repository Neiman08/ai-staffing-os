/**
 * F11.4: funnel real de reclutamiento -- sourced -> qualified ->
 * shortlisted -> placed, time-to-fill y efectividad por fuente. Cada
 * etapa es un conteo real de candidatos distintos sobre datos ya
 * persistidos por F8 (CandidateQualification/CandidateShortlistEntry) y
 * F9.4 (Placement) -- ninguna query nueva duplica un cálculo que otro
 * módulo ya hace; esta es agregación nueva porque ningún endpoint
 * existente arma un funnel (dashboard/service.ts solo tiene
 * candidatesByStatus, sin las etapas de calificación/shortlist/
 * colocación).
 */
import type { AnalyticsPeriodQuery, RecruitingFunnel, RecruitingMetrics } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { comparePeriods, daysBetween, previousPeriod, resolvePeriod, toResolvedPeriod, type DateRange } from "../../core/analytics/period";

const DEFAULT_WINDOW_DAYS = 90;

// Estados de Placement que representan una colocación real (no un
// borrador ni una cancelada) -- mismo vocabulario ya usado por
// PlacementStatus en schema.prisma, ninguno inventado acá.
const REAL_PLACEMENT_STATUSES = ["APPROVED", "READY_FOR_ONBOARDING", "ACTIVE", "COMPLETED"] as const;

/**
 * F11.7: mismas cuatro queries del funnel, aisladas para poder correrlas
 * también contra el período anterior (comparación) sin duplicar la
 * lógica de conteo -- devuelve solo los números, nunca las filas
 * completas (esas solo se necesitan para el período actual, de donde
 * también sale sourceEffectiveness/timeToFill).
 */
async function countFunnelStages(range: DateRange): Promise<RecruitingFunnel> {
  const createdInPeriod = { gte: range.from, lte: range.to };
  const [sourced, qualified, shortlisted, placed] = await Promise.all([
    scopedDb.candidate.count({ where: { createdAt: createdInPeriod } }),
    scopedDb.candidateQualification
      .findMany({ where: { status: "QUALIFIED", createdAt: createdInPeriod }, select: { candidateId: true }, distinct: ["candidateId"] })
      .then((rows) => rows.length),
    scopedDb.candidateShortlistEntry
      .findMany({ where: { addedAt: createdInPeriod }, select: { candidateId: true }, distinct: ["candidateId"] })
      .then((rows) => rows.length),
    scopedDb.placement
      .findMany({
        where: { status: { in: [...REAL_PLACEMENT_STATUSES] }, createdAt: createdInPeriod },
        select: { candidateId: true },
        distinct: ["candidateId"],
      })
      .then((rows) => rows.length),
  ]);
  return { sourced, qualified, shortlisted, placed };
}

export async function getRecruitingMetrics(query: AnalyticsPeriodQuery): Promise<RecruitingMetrics> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);
  const canViewCandidates = has("candidates.view");
  const canViewJobOrders = has("jobOrders.view");

  if (!canViewCandidates) {
    return { generatedAt: new Date().toISOString(), recruiting: {} };
  }

  const range = resolvePeriod(query, DEFAULT_WINDOW_DAYS);
  const period = toResolvedPeriod(range);
  const createdInPeriod = { gte: range.from, lte: range.to };

  const [sourcedCandidates, qualifiedRows, shortlistedRows, placedRows] = await Promise.all([
    scopedDb.candidate.findMany({
      where: { createdAt: createdInPeriod },
      select: { id: true, source: true },
    }),
    scopedDb.candidateQualification.findMany({
      where: { status: "QUALIFIED", createdAt: createdInPeriod },
      select: { candidateId: true },
      distinct: ["candidateId"],
    }),
    scopedDb.candidateShortlistEntry.findMany({
      where: { addedAt: createdInPeriod },
      select: { candidateId: true },
      distinct: ["candidateId"],
    }),
    scopedDb.placement.findMany({
      where: { status: { in: [...REAL_PLACEMENT_STATUSES] }, createdAt: createdInPeriod },
      select: { candidateId: true, jobOrderId: true, createdAt: true },
    }),
  ]);

  const placedCandidateIds = new Set(placedRows.map((p) => p.candidateId));

  const funnel = {
    sourced: sourcedCandidates.length,
    qualified: qualifiedRows.length,
    shortlisted: shortlistedRows.length,
    placed: placedCandidateIds.size,
  };

  let timeToFill: RecruitingMetrics["recruiting"]["timeToFill"];
  if (canViewJobOrders) {
    // Un solo Job Order puede acumular varias Placements reales (varias
    // vacantes) -- el tiempo de llenado se mide contra la PRIMERA
    // colocación real, que es cuando el Job Order empezó a llenarse.
    const earliestByJobOrder = new Map<string, Date>();
    for (const p of placedRows) {
      const existing = earliestByJobOrder.get(p.jobOrderId);
      if (!existing || p.createdAt < existing) earliestByJobOrder.set(p.jobOrderId, p.createdAt);
    }
    const jobOrderIds = [...earliestByJobOrder.keys()];
    const jobOrders = jobOrderIds.length
      ? await scopedDb.jobOrder.findMany({ where: { id: { in: jobOrderIds } }, select: { id: true, createdAt: true } })
      : [];
    const jobOrderCreatedAt = new Map(jobOrders.map((jo) => [jo.id, jo.createdAt]));

    const days = jobOrderIds
      .map((id) => {
        const filledAt = earliestByJobOrder.get(id)!;
        const openedAt = jobOrderCreatedAt.get(id);
        return openedAt ? daysBetween(openedAt, filledAt) : null;
      })
      .filter((d): d is number => d !== null);

    timeToFill = {
      averageDays: days.length ? Number((days.reduce((sum, d) => sum + d, 0) / days.length).toFixed(1)) : null,
      jobOrdersFilled: days.length,
    };
  }

  const sourceGroups = new Map<string, { candidateCount: number; placedCount: number }>();
  for (const c of sourcedCandidates) {
    const key = c.source?.trim() || "Unknown";
    const entry = sourceGroups.get(key) ?? { candidateCount: 0, placedCount: 0 };
    entry.candidateCount += 1;
    if (placedCandidateIds.has(c.id)) entry.placedCount += 1;
    sourceGroups.set(key, entry);
  }
  const sourceEffectiveness = [...sourceGroups.entries()]
    .map(([source, v]) => ({
      source,
      candidateCount: v.candidateCount,
      placedCount: v.placedCount,
      placementRate: v.candidateCount > 0 ? Number(((v.placedCount / v.candidateCount) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.candidateCount - a.candidateCount);

  // F11.7: mismo funnel, recalculado sobre el período inmediatamente
  // anterior de igual duración -- comparación real, nunca una tendencia
  // inferida de menos de dos puntos de datos reales.
  const previousRange = previousPeriod(range);
  const previousFunnel = await countFunnelStages(previousRange);
  const funnelComparison = {
    sourced: comparePeriods(funnel.sourced, previousFunnel.sourced),
    qualified: comparePeriods(funnel.qualified, previousFunnel.qualified),
    shortlisted: comparePeriods(funnel.shortlisted, previousFunnel.shortlisted),
    placed: comparePeriods(funnel.placed, previousFunnel.placed),
  };

  return {
    generatedAt: new Date().toISOString(),
    recruiting: {
      period,
      previousPeriod: toResolvedPeriod(previousRange),
      funnel,
      funnelComparison,
      timeToFill,
      sourceEffectiveness,
    },
  };
}
