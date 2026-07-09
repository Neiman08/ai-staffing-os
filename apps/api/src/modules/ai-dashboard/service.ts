import type { AiDashboardSummary } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { getMonthlyBudgetStatus } from "../agents/budget";

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * F3 §12: Dashboard Comercial IA. ROI se modela explícitamente como
 * estimado (ingresos estimados de oportunidades creadas por IA ÷ costo
 * IA del mes) — nunca como revenue realizado, decisión aprobada. El
 * "mapa de oportunidades" se simplifica a un desglose por estado
 * (companiesByState) en vez de un mapa geográfico real — también
 * aprobado, evita una librería de mapas nueva.
 */
export async function getAiDashboardSummary(): Promise<AiDashboardSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const today = startOfDay();

  const [
    companiesAnalyzedToday,
    newCompaniesToday,
    leadsCreatedByAiToday,
    scoreAgg,
    budget,
    aiOpportunities,
    pendingProspects,
    pendingApprovals,
    companiesByIndustryRaw,
    companiesByStateRaw,
  ] = await Promise.all([
    scopedDb.agentTask.count({ where: { type: "score_company", status: "DONE", completedAt: { gte: today } } }),
    scopedDb.company.count({ where: { createdAt: { gte: today } } }),
    scopedDb.lead.count({ where: { createdByAgentTaskId: { not: null }, createdAt: { gte: today } } }),
    scopedDb.company.aggregate({ _avg: { commercialScore: true }, where: { commercialScore: { not: null } } }),
    getMonthlyBudgetStatus(ctx.tenantId),
    scopedDb.opportunity.findMany({
      where: { createdByAgentTaskId: { not: null } },
      select: { estimatedRevenue: true },
    }),
    scopedDb.lead.count({ where: { createdByAgentTaskId: { not: null }, status: { in: ["NEW", "CONTACTED"] } } }),
    scopedDb.approvalRequest.count({ where: { status: "PENDING" } }),
    scopedDb.company.groupBy({ by: ["industryId"], _count: { _all: true } }),
    scopedDb.company.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);

  const industries = await scopedDb.industry.findMany({
    where: { id: { in: companiesByIndustryRaw.map((r) => r.industryId) } },
  });
  const industryNameById = new Map(industries.map((i) => [i.id, i.name]));

  const estimatedRevenueUsd = aiOpportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

  return {
    companiesAnalyzedToday,
    newCompaniesToday,
    leadsCreatedByAiToday,
    averageScore: scoreAgg._avg.commercialScore,
    costUsdThisMonth: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
    roiEstimate: {
      estimatedRevenueUsd,
      costUsd: budget.spentUsd,
      ratio: budget.spentUsd > 0 ? estimatedRevenueUsd / budget.spentUsd : null,
    },
    pendingProspects,
    pendingApprovals,
    companiesByIndustry: companiesByIndustryRaw.map((r) => ({
      industryName: industryNameById.get(r.industryId) ?? "—",
      count: r._count._all,
    })),
    companiesByState: companiesByStateRaw
      .filter((r): r is typeof r & { state: string } => !!r.state)
      .map((r) => ({ state: r.state, count: r._count._all })),
  };
}
