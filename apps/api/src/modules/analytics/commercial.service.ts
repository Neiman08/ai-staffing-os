/**
 * F11.5: win-rate, duración de ciclo de venta y conversión -- extiende
 * revenue/service.ts (que solo tiene pipeline/leads/meetings, sin
 * ganar/perder ni duración) con datos ya persistidos por F1 (Lead) y F1
 * (Opportunity), ambos con OpportunityStage/LeadStatus reales, nada
 * inventado.
 */
import type { AnalyticsPeriodQuery, CommercialMetrics } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { daysBetween, resolvePeriod, toResolvedPeriod } from "../../core/analytics/period";

const DEFAULT_WINDOW_DAYS = 90;

export async function getCommercialMetrics(query: AnalyticsPeriodQuery): Promise<CommercialMetrics> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);
  const canViewOpportunities = has("opportunities.view");
  const canViewLeads = has("leads.view");

  if (!canViewOpportunities && !canViewLeads) {
    return { generatedAt: new Date().toISOString(), commercial: {} };
  }

  const range = resolvePeriod(query, DEFAULT_WINDOW_DAYS);
  const period = toResolvedPeriod(range);
  const updatedInPeriod = { gte: range.from, lte: range.to };
  const createdInPeriod = { gte: range.from, lte: range.to };

  const commercial: CommercialMetrics["commercial"] = { period };

  if (canViewOpportunities) {
    // Opportunity no tiene un campo closedAt dedicado -- updatedAt es el
    // mejor proxy real disponible para "cuándo se resolvió" (se filtra
    // por updatedAt, no por createdAt, para capturar oportunidades
    // abiertas antes del período pero cerradas dentro de él).
    const closedOpportunities = await scopedDb.opportunity.findMany({
      where: { stage: { in: ["WON", "LOST"] }, updatedAt: updatedInPeriod },
      select: { stage: true, createdAt: true, updatedAt: true },
    });

    const won = closedOpportunities.filter((o) => o.stage === "WON");
    const lost = closedOpportunities.filter((o) => o.stage === "LOST");
    const totalClosed = won.length + lost.length;

    commercial.winRate = {
      won: won.length,
      lost: lost.length,
      winRatePercent: totalClosed > 0 ? Number(((won.length / totalClosed) * 100).toFixed(1)) : null,
    };

    const cycleDays = won.map((o) => daysBetween(o.createdAt, o.updatedAt)).filter((d) => d >= 0);
    commercial.salesCycle = {
      averageDays: cycleDays.length ? Number((cycleDays.reduce((sum, d) => sum + d, 0) / cycleDays.length).toFixed(1)) : null,
      opportunitiesWon: won.length,
    };
  }

  if (canViewLeads) {
    const leads = await scopedDb.lead.findMany({
      where: { createdAt: createdInPeriod },
      select: { id: true, status: true, companyId: true },
    });
    const converted = leads.filter((l) => l.status === "CONVERTED").length;

    commercial.conversion = {
      leadConversionRate: leads.length > 0 ? Number(((converted / leads.length) * 100).toFixed(1)) : null,
    };

    if (canViewOpportunities) {
      const companyIds = [...new Set(leads.map((l) => l.companyId).filter((id): id is string => !!id))];
      if (companyIds.length > 0) {
        const companiesWithOpportunity = await scopedDb.opportunity.findMany({
          where: { companyId: { in: companyIds } },
          select: { companyId: true },
          distinct: ["companyId"],
        });
        commercial.conversion.leadToOpportunityRate = Number(
          ((companiesWithOpportunity.length / companyIds.length) * 100).toFixed(1),
        );
      } else {
        commercial.conversion.leadToOpportunityRate = null;
      }
    }
  }

  return { generatedAt: new Date().toISOString(), commercial };
}
