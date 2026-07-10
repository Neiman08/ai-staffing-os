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
 *
 * F4 §17: extensión aditiva — campañas, empresas calientes/frías/
 * recuperadas, costo por campaña/lead/oportunidad, tiempo ahorrado
 * (estimado, supuesto documentado) y productividad IA. costUsdByCampaign
 * suma el costo de las tareas encadenadas (parentTaskId) a partir de
 * CampaignCompany.createdByAgentTaskId — no captura measureCampaign/
 * optimizeCampaign invocadas sueltas (costo marginal, ver nota abajo).
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
    campaignsActive,
    campaignsCompleted,
    companiesByCampaignRaw,
    companiesHot,
    companiesCold,
    companiesRecovered,
    campaigns,
    aiLeadsTotal,
    aiOpportunitiesTotal,
    outreachTasksCompleted,
    outreachCostUsd,
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
    scopedDb.campaign.count({ where: { status: "ACTIVE" } }),
    scopedDb.campaign.count({ where: { status: "COMPLETED" } }),
    scopedDb.campaignCompany.groupBy({ by: ["campaignId"], _count: { _all: true } }),
    scopedDb.campaignCompany.count({ where: { status: "HOT" } }),
    scopedDb.campaignCompany.count({ where: { status: "COLD" } }),
    scopedDb.campaignCompany.count({ where: { status: "RECOVERED" } }),
    scopedDb.campaign.findMany({ select: { id: true, name: true } }),
    scopedDb.lead.count({ where: { createdByAgentTaskId: { not: null } } }),
    scopedDb.opportunity.count({ where: { createdByAgentTaskId: { not: null } } }),
    scopedDb.agentTask.count({
      where: {
        type: { in: ["personalize_message", "classify_conversation", "plan_sequence", "suggest_next_step"] },
        status: "DONE",
      },
    }),
    scopedDb.agentTask.aggregate({
      where: { type: { in: ["personalize_message", "classify_conversation", "plan_sequence", "suggest_next_step"] } },
      _sum: { costUsd: true },
    }),
  ]);

  const industries = await scopedDb.industry.findMany({
    where: { id: { in: companiesByIndustryRaw.map((r) => r.industryId) } },
  });
  const industryNameById = new Map(industries.map((i) => [i.id, i.name]));

  const estimatedRevenueUsd = aiOpportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

  const campaignNameById = new Map(campaigns.map((c) => [c.id, c.name]));
  const companiesByCampaign = companiesByCampaignRaw.map((r) => ({
    campaignName: campaignNameById.get(r.campaignId) ?? "—",
    count: r._count._all,
  }));

  const costUsdByCampaign = await Promise.all(
    campaigns.map(async (campaign) => {
      const rootIds = (
        await scopedDb.campaignCompany.findMany({
          where: { campaignId: campaign.id, createdByAgentTaskId: { not: null } },
          select: { createdByAgentTaskId: true },
        })
      )
        .map((c) => c.createdByAgentTaskId!)
        .filter(Boolean);
      if (rootIds.length === 0) return { campaignName: campaign.name, costUsd: 0 };
      const agg = await scopedDb.agentTask.aggregate({
        where: { OR: [{ id: { in: rootIds } }, { parentTaskId: { in: rootIds } }] },
        _sum: { costUsd: true },
      });
      return { campaignName: campaign.name, costUsd: Number(agg._sum.costUsd ?? 0) };
    }),
  );

  const costPerLeadUsd = aiLeadsTotal > 0 ? budget.spentUsd / aiLeadsTotal : null;
  const costPerOpportunityUsd = aiOpportunitiesTotal > 0 ? budget.spentUsd / aiOpportunitiesTotal : null;

  // Estimado explícito (no medido): minutos que le tomaría a un humano
  // redactar cada mensaje de outreach personalizado a mano — supuesto
  // documentado, F4 §17.
  const MINUTES_SAVED_PER_MESSAGE = 8;
  const estimatedTimeSavedMinutes = outreachTasksCompleted * MINUTES_SAVED_PER_MESSAGE;

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
    campaignsActive,
    campaignsCompleted,
    companiesByCampaign,
    companiesHot,
    companiesCold,
    companiesRecovered,
    costUsdByCampaign,
    costPerLeadUsd,
    costPerOpportunityUsd,
    estimatedTimeSavedMinutes,
    aiProductivity: { tasksCompleted: outreachTasksCompleted, costUsd: Number(outreachCostUsd._sum.costUsd ?? 0) },
  };
}
