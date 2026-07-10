import { z } from "zod";
import {
  CAMPAIGN_AGENT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  createCampaignTool as createCampaignToolStub,
  createCampaignInputSchema,
  measureCampaignTool as measureCampaignToolStub,
  measureCampaignInputSchema,
  optimizeCampaignTool as optimizeCampaignToolStub,
  optimizeCampaignInputSchema,
  selectTargetCompaniesTool as selectTargetCompaniesToolStub,
  selectTargetCompaniesInputSchema,
  type AgentTool,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import type { UsageAccumulator } from "../usage";

const COMPANY_SIZE_ORDER = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"] as const;

function sizesBetween(min?: string | null, max?: string | null): string[] | undefined {
  if (!min && !max) return undefined;
  const minIdx = min ? COMPANY_SIZE_ORDER.indexOf(min as (typeof COMPANY_SIZE_ORDER)[number]) : 0;
  const maxIdx = max ? COMPANY_SIZE_ORDER.indexOf(max as (typeof COMPANY_SIZE_ORDER)[number]) : COMPANY_SIZE_ORDER.length - 1;
  return COMPANY_SIZE_ORDER.slice(minIdx, maxIdx + 1);
}

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return schema.parse(parsed);
  } catch {
    return null;
  }
}

async function auditAgentAction(params: {
  agentInstanceId: string;
  action: string;
  entityType: string;
  entityId: string;
  after?: unknown;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "AGENT",
      actorId: params.agentInstanceId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      after: params.after as never,
    },
  });
}

/**
 * F4 §11: dedup determinista — reutiliza una Campaign DRAFT/ACTIVE con
 * criterios equivalentes (industria + ubicación + solape de categorías)
 * en vez de crear una segunda. Usado tanto por el tool del Campaign
 * Agent como por el endpoint humano POST /campaigns (campaigns/service.ts
 * importa esta misma función — no se duplica la lógica).
 */
export async function createOrReuseCampaign(
  input: z.infer<typeof createCampaignInputSchema>,
  createdByAgentTaskId: string | null,
) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const candidates = await scopedDb.campaign.findMany({
    where: {
      status: { in: ["DRAFT", "ACTIVE"] },
      industryId: input.industryId ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
    },
  });

  const targetIds = new Set(input.targetCategoryIds ?? []);
  const existing = candidates.find((c) => {
    const existingIds = (c.targetCategoryIds as string[]) ?? [];
    if (targetIds.size === 0 || existingIds.length === 0) return true; // sin categorías específicas de ningún lado — se considera equivalente
    return existingIds.some((id) => targetIds.has(id));
  });

  if (existing) return { campaign: existing, reused: true };

  const campaign = await scopedDb.campaign.create({
    data: {
      tenantId: ctx.tenantId,
      name: input.name,
      // Una campaña creada por el Campaign Agent (ej. desde la Daily
      // Revenue Mission) arranca ACTIVE de inmediato — esa es la razón
      // de ser de la autonomía. Una creada por un humano vía POST
      // /campaigns arranca DRAFT (default del schema) para que la
      // revise antes de activarla — createdByAgentTaskId es null en
      // ese caso.
      status: createdByAgentTaskId ? "ACTIVE" : undefined,
      industryId: input.industryId,
      state: input.state,
      city: input.city,
      minCompanySize: input.minCompanySize,
      maxCompanySize: input.maxCompanySize,
      targetCategoryIds: input.targetCategoryIds ?? [],
      minScore: input.minScore,
      priority: input.priority ?? "MEDIUM",
      createdByAgentTaskId,
    },
  });
  return { campaign, reused: false };
}

/**
 * F4: agrega el costo real de una campaña sumando las tareas encadenadas
 * (parentTaskId) a partir de CampaignCompany.createdByAgentTaskId — ver
 * F4_AUTONOMOUS_OUTREACH_PLAN.md §17. No captura measureCampaign/
 * optimizeCampaign invocadas sueltas (sin costo o costo marginal) — misma
 * limitación documentada que en ai-dashboard/service.ts.
 */
export async function computeCampaignMetrics(campaignId: string) {
  const [statusGroups, companyRows] = await Promise.all([
    scopedDb.campaignCompany.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } }),
    scopedDb.campaignCompany.findMany({ where: { campaignId }, select: { companyId: true, createdByAgentTaskId: true } }),
  ]);

  const statusCounts = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all]));
  const companyIds = companyRows.map((r) => r.companyId);
  const rootIds = companyRows.map((r) => r.createdByAgentTaskId).filter((id): id is string => !!id);

  const [leadsCreated, opportunities, costAgg] = await Promise.all([
    scopedDb.lead.count({ where: { companyId: { in: companyIds }, createdByAgentTaskId: { not: null } } }),
    scopedDb.opportunity.findMany({
      where: { companyId: { in: companyIds }, createdByAgentTaskId: { not: null } },
      select: { estimatedRevenue: true },
    }),
    rootIds.length > 0
      ? scopedDb.agentTask.aggregate({
          where: { OR: [{ id: { in: rootIds } }, { parentTaskId: { in: rootIds } }] },
          _sum: { costUsd: true },
        })
      : Promise.resolve({ _sum: { costUsd: null } }),
  ]);

  return {
    statusCounts,
    costUsd: Number(costAgg._sum.costUsd ?? 0),
    leadsCreated,
    opportunitiesCreated: opportunities.length,
    opportunitiesValueUsd: opportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0),
  };
}

export interface CampaignToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * F4: tools del Campaign Agent. createCampaign/selectTargetCompanies/
 * measureCampaign son deterministas (sin LLM) — solo optimizeCampaign usa
 * el patrón híbrido D8, y solo recomienda (nunca cambia la campaña).
 */
export function createCampaignTools(deps: CampaignToolDeps): AgentTool[] {
  return [
    {
      ...createCampaignToolStub,
      async execute(input: z.infer<typeof createCampaignInputSchema>) {
        const { campaign, reused } = await createOrReuseCampaign(input, deps.taskId);
        if (!reused) {
          await auditAgentAction({
            agentInstanceId: deps.agentInstanceId,
            action: "campaign.created_by_agent",
            entityType: "campaign",
            entityId: campaign.id,
            after: { name: campaign.name },
          });
        }
        return { campaignId: campaign.id, reused };
      },
    },

    {
      ...selectTargetCompaniesToolStub,
      async execute(input: z.infer<typeof selectTargetCompaniesInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const campaign = await scopedDb.campaign.findUnique({ where: { id: input.campaignId } });
        if (!campaign) throw AppError.notFound("Campaign not found");

        const sizes = sizesBetween(campaign.minCompanySize, campaign.maxCompanySize);
        const targetCategoryIds = (campaign.targetCategoryIds as string[]) ?? [];

        const excludedElsewhere = await scopedDb.campaignCompany.findMany({
          where: {
            status: { in: ["TARGETED", "SEQUENCING", "HOT", "RECOVERED"] },
            campaign: { status: "ACTIVE" },
          },
          select: { companyId: true },
        });

        const candidates = await scopedDb.company.findMany({
          where: {
            industryId: campaign.industryId ?? undefined,
            state: campaign.state ?? undefined,
            city: campaign.city ?? undefined,
            estimatedSize: sizes ? { in: sizes as never } : undefined,
            commercialScore: campaign.minScore != null ? { gte: campaign.minScore } : undefined,
            id: { notIn: excludedElsewhere.map((c) => c.companyId) },
            ...(targetCategoryIds.length > 0
              ? { possibleCategories: { some: { id: { in: targetCategoryIds } } } }
              : {}),
          },
          orderBy: [{ commercialScore: "desc" }, { createdAt: "asc" }],
          take: input.limit ?? 50,
        });

        const alreadyInCampaign = new Set(
          (
            await scopedDb.campaignCompany.findMany({
              where: { campaignId: input.campaignId, companyId: { in: candidates.map((c) => c.id) } },
              select: { companyId: true },
            })
          ).map((c) => c.companyId),
        );
        const newCompanies = candidates.filter((c) => !alreadyInCampaign.has(c.id));

        if (newCompanies.length > 0) {
          await scopedDb.campaignCompany.createMany({
            data: newCompanies.map((c) => ({
              tenantId: ctx.tenantId,
              campaignId: input.campaignId,
              companyId: c.id,
              createdByAgentTaskId: deps.taskId,
            })),
          });
          await auditAgentAction({
            agentInstanceId: deps.agentInstanceId,
            action: "campaign.companies_selected_by_agent",
            entityType: "campaign",
            entityId: input.campaignId,
            after: { addedCount: newCompanies.length },
          });
        }

        return { companyIds: newCompanies.map((c) => c.id), addedCount: newCompanies.length };
      },
    },

    {
      ...measureCampaignToolStub,
      async execute(input: z.infer<typeof measureCampaignInputSchema>) {
        const campaign = await scopedDb.campaign.findUnique({ where: { id: input.campaignId } });
        if (!campaign) throw AppError.notFound("Campaign not found");
        return computeCampaignMetrics(input.campaignId);
      },
    },

    {
      ...optimizeCampaignToolStub,
      async execute(input: z.infer<typeof optimizeCampaignInputSchema>) {
        const campaign = await scopedDb.campaign.findUnique({ where: { id: input.campaignId } });
        if (!campaign) throw AppError.notFound("Campaign not found");

        const metrics = await computeCampaignMetrics(input.campaignId);

        const prompt = `Campaña: ${campaign.name}
Empresas por estado: ${JSON.stringify(metrics.statusCounts)}
Costo IA acumulado: $${metrics.costUsd.toFixed(4)}
Leads creados: ${metrics.leadsCreated}
Oportunidades creadas: ${metrics.opportunitiesCreated} (valor estimado $${metrics.opportunitiesValueUsd.toFixed(2)})

Responde ÚNICAMENTE con un JSON de la forma {"recommendation": "<2-3 frases en español recomendando cómo mejorar esta campaña, basadas solo en las métricas de arriba — nunca prometas cambiarla vos mismo, solo recomendás>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: CAMPAIGN_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(completion.content, z.object({ recommendation: z.string().min(1) }));
        const recommendation =
          parsed?.recommendation ??
          `Recomendación no disponible (el modelo no devolvió una respuesta válida). Métricas: ${JSON.stringify(metrics.statusCounts)}.`;

        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "campaign.optimization_recommended_by_agent",
          entityType: "campaign",
          entityId: input.campaignId,
          after: { recommendation },
        });

        return { recommendation };
      },
    },
  ];
}
