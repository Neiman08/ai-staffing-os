import type {
  CampaignCompanyDetail,
  CampaignCompanyTaskInput,
  CampaignDetail,
  CampaignListItem,
  CampaignQuery,
  CampaignTaskInput,
  CreateCampaignInput,
  LogConversationInput,
  LogConversationResult,
  Paginated,
  UpdateCampaignInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { createOrReuseCampaign, computeCampaignMetrics } from "../agents/tools/campaign-tools.impl";
import { createQueuedTask, runTaskAsync, createAndRunTaskSync, toAgentTaskDetail } from "../agents/task-executor";

/** POST /campaigns — formulario humano, sin AgentTask (mismo camino que POST /companies). */
export async function createCampaign(input: CreateCampaignInput) {
  const { campaign, reused } = await createOrReuseCampaign(input, null);
  return { campaignId: campaign.id, reused };
}

async function toListItem(campaign: {
  id: string;
  name: string;
  status: string;
  industryId: string | null;
  state: string | null;
  city: string | null;
  minCompanySize: string | null;
  maxCompanySize: string | null;
  minScore: number | null;
  priority: string;
  createdByAgentTaskId: string | null;
  createdAt: Date;
}): Promise<CampaignListItem> {
  const [industry, metrics] = await Promise.all([
    campaign.industryId ? scopedDb.industry.findUnique({ where: { id: campaign.industryId } }) : null,
    computeCampaignMetrics(campaign.id),
  ]);

  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status as CampaignListItem["status"],
    industryName: industry?.name ?? null,
    state: campaign.state,
    city: campaign.city,
    minCompanySize: campaign.minCompanySize as CampaignListItem["minCompanySize"],
    maxCompanySize: campaign.maxCompanySize as CampaignListItem["maxCompanySize"],
    minScore: campaign.minScore,
    priority: campaign.priority as CampaignListItem["priority"],
    createdByAgentTaskId: campaign.createdByAgentTaskId,
    statusCounts: metrics.statusCounts,
    costUsd: metrics.costUsd,
    createdAt: campaign.createdAt.toISOString(),
  };
}

export async function listCampaigns(query: CampaignQuery): Promise<Paginated<CampaignListItem>> {
  const rows = await scopedDb.campaign.findMany({
    ...buildCursorArgs(query),
    where: { status: query.status },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const { items, nextCursor } = toCursorPage(rows, query.limit);
  return { items: await Promise.all(items.map(toListItem)), nextCursor };
}

export async function getCampaignDetail(id: string): Promise<CampaignDetail> {
  const campaign = await scopedDb.campaign.findUnique({ where: { id } });
  if (!campaign) throw AppError.notFound("Campaign not found");

  const [listItem, metrics, companyRows, latestRecommendationTask] = await Promise.all([
    toListItem(campaign),
    computeCampaignMetrics(id),
    scopedDb.campaignCompany.findMany({
      where: { campaignId: id },
      include: { company: true },
      orderBy: { createdAt: "desc" },
    }),
    scopedDb.agentTask.findFirst({
      where: { type: "optimize_campaign", status: "DONE", input: { equals: { campaignId: id } } },
      orderBy: { completedAt: "desc" },
    }),
  ]);

  const recommendation = latestRecommendationTask?.output
    ? ((latestRecommendationTask.output as { recommendation?: string }).recommendation ?? null)
    : null;

  return {
    ...listItem,
    targetCategoryIds: (campaign.targetCategoryIds as string[]) ?? [],
    leadsCreated: metrics.leadsCreated,
    opportunitiesCreated: metrics.opportunitiesCreated,
    opportunitiesValueUsd: metrics.opportunitiesValueUsd,
    latestRecommendation: recommendation,
    companies: companyRows.map((c) => ({
      id: c.id,
      campaignId: c.campaignId,
      companyId: c.companyId,
      companyName: c.company.name,
      status: c.status as never,
      lastIntent: c.lastIntent as never,
      lastIntentAt: c.lastIntentAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      companyOrigin: c.company.origin,
      companySourceUrl: c.company.sourceUrl,
    })),
  };
}

export async function updateCampaign(id: string, input: UpdateCampaignInput): Promise<CampaignListItem> {
  const existing = await scopedDb.campaign.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Campaign not found");

  const campaign = await scopedDb.campaign.update({
    where: { id },
    data: {
      status: input.status,
      name: input.name,
      minScore: input.minScore,
      priority: input.priority,
    },
  });
  return toListItem(campaign);
}

/** POST /campaigns/:id/tasks — invoca al Campaign Agent (async, mismo patrón que F2/F3). */
export async function triggerCampaignTask(campaignId: string, input: CampaignTaskInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const campaign = await scopedDb.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw AppError.notFound("Campaign not found");

  const task = await createQueuedTask({
    agentKey: "campaign",
    type: input.type,
    input: { campaignId, ...input.input },
    triggeredBy: "USER",
    parentTaskId: campaign.createdByAgentTaskId ?? undefined,
  });
  runTaskAsync(task.id, ctx.tenantId, ctx.userId);
  return toAgentTaskDetail(task);
}

export async function getCampaignCompanyDetail(id: string): Promise<CampaignCompanyDetail> {
  const cc = await scopedDb.campaignCompany.findUnique({
    where: { id },
    include: { company: { include: { industry: true } } },
  });
  if (!cc) throw AppError.notFound("CampaignCompany not found");

  const [sequence, recentActivity] = await Promise.all([
    scopedDb.followUp.findMany({
      where: { campaignId: cc.campaignId, entityType: "company", entityId: cc.companyId },
      orderBy: { dueDate: "asc" },
    }),
    scopedDb.activity.findMany({
      where: { entityType: "campaignCompany", entityId: cc.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    id: cc.id,
    campaignId: cc.campaignId,
    companyId: cc.companyId,
    companyName: cc.company.name,
    status: cc.status as never,
    lastIntent: cc.lastIntent as never,
    lastIntentAt: cc.lastIntentAt?.toISOString() ?? null,
    createdAt: cc.createdAt.toISOString(),
    companyOrigin: cc.company.origin,
    companySourceUrl: cc.company.sourceUrl,
    industryName: cc.company.industry.name,
    commercialScore: cc.company.commercialScore,
    sequence: sequence.map((f) => ({
      id: f.id,
      type: f.type,
      status: f.status,
      dueDate: f.dueDate.toISOString(),
      notes: f.notes,
      createdByAgentTaskId: f.createdByAgentTaskId,
    })),
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      type: a.type,
      subject: a.subject,
      body: a.body,
      performedByLabel: a.performedByAgentId ? "Agente IA" : "Usuario",
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * POST /campaign-companies/:id/tasks — invoca al Outreach Agent (async).
 * parentTaskId apunta a CampaignCompany.createdByAgentTaskId (la tarea
 * select_target_companies que agregó esta empresa) — es lo que hace que
 * computeCampaignMetrics pueda sumar el costo real de personalizeMessage
 * como parte del costo de la campaña (F4 §17).
 */
export async function triggerCampaignCompanyTask(campaignCompanyId: string, input: CampaignCompanyTaskInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const cc = await scopedDb.campaignCompany.findUnique({ where: { id: campaignCompanyId } });
  if (!cc) throw AppError.notFound("CampaignCompany not found");

  const task = await createQueuedTask({
    agentKey: "outreach",
    type: input.type,
    input: { campaignCompanyId, ...input.input },
    triggeredBy: "USER",
    parentTaskId: cc.createdByAgentTaskId ?? undefined,
  });
  runTaskAsync(task.id, ctx.tenantId, ctx.userId);
  return toAgentTaskDetail(task);
}

/**
 * POST /campaign-companies/:id/conversation — a diferencia de los demás
 * disparadores de F4, este corre SÍNCRONO (createAndRunTaskSync, ya
 * probado en el scheduler/prospecting-tools.impl.ts): pegar una
 * respuesta y ver la clasificación al toque es mejor UX que hacer
 * polling para una acción puntual disparada por un humano.
 */
export async function logConversation(
  campaignCompanyId: string,
  input: LogConversationInput,
): Promise<LogConversationResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const cc = await scopedDb.campaignCompany.findUnique({ where: { id: campaignCompanyId } });
  if (!cc) throw AppError.notFound("CampaignCompany not found");

  const task = await createAndRunTaskSync(ctx.tenantId, ctx.userId, {
    agentKey: "conversation",
    type: "classify_conversation",
    input: { campaignCompanyId, replyText: input.replyText },
    triggeredBy: "USER",
    parentTaskId: cc.createdByAgentTaskId ?? undefined,
  });

  if (task.status === "FAILED") {
    throw AppError.internal(task.errorMessage ?? "No se pudo clasificar la respuesta.");
  }

  return task.output as LogConversationResult;
}
