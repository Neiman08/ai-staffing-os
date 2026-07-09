import type {
  CreateOpportunityInput,
  OpportunityDetail,
  OpportunityListItem,
  OpportunityQuery,
  Paginated,
  PipelineResponse,
  UpdateOpportunityInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";

const PIPELINE_STAGES = ["MEETING_SCHEDULED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST"] as const;

function marginPerHour(payRate: unknown, billRate: unknown): string | null {
  if (payRate == null || billRate == null) return null;
  return (Number(billRate) - Number(payRate)).toFixed(2);
}

async function nextFollowUpsAndActivity(entityType: string, id: string) {
  const [followUps, activities] = await Promise.all([
    scopedDb.followUp.findMany({
      where: { entityType, entityId: id, status: "PENDING" },
      orderBy: { dueDate: "asc" },
      take: 5,
    }),
    scopedDb.activity.findMany({
      where: { entityType, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  return { followUps, activities };
}

export async function listOpportunities(query: OpportunityQuery): Promise<Paginated<OpportunityListItem>> {
  const rows = await scopedDb.opportunity.findMany({
    ...buildCursorArgs(query),
    where: {
      stage: query.stage as never,
      companyId: query.companyId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { company: true, category: true },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  const ownerLabels = await labelUsers(items.filter((o) => o.ownerId).map((o) => o.ownerId!));

  return {
    items: items.map((o) => ({
      id: o.id,
      title: o.title,
      companyId: o.companyId,
      companyName: o.company.name,
      stage: o.stage,
      categoryName: o.category?.name ?? null,
      estimatedWorkers: o.estimatedWorkers,
      estimatedPayRate: o.estimatedPayRate?.toString() ?? null,
      estimatedBillRate: o.estimatedBillRate?.toString() ?? null,
      estimatedMarginPerHour: marginPerHour(o.estimatedPayRate, o.estimatedBillRate),
      estimatedRevenue: o.estimatedRevenue?.toString() ?? null,
      probability: o.probability,
      expectedCloseDate: o.expectedCloseDate?.toISOString() ?? null,
      ownerLabel: o.ownerId ? (ownerLabels.get(o.ownerId) ?? null) : null,
      createdAt: o.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getOpportunityDetail(id: string): Promise<OpportunityDetail> {
  const o = await scopedDb.opportunity.findUnique({
    where: { id },
    include: { company: true, category: true },
  });
  if (!o) throw AppError.notFound("Opportunity not found");

  const { followUps, activities } = await nextFollowUpsAndActivity("opportunity", id);
  const ownerLabels = await labelUsers(o.ownerId ? [o.ownerId] : []);
  const actorIds = activities.filter((a) => a.performedById).map((a) => a.performedById!);
  const actorLabels = await labelUsers(actorIds);

  return {
    id: o.id,
    title: o.title,
    companyId: o.companyId,
    companyName: o.company.name,
    stage: o.stage,
    categoryName: o.category?.name ?? null,
    estimatedWorkers: o.estimatedWorkers,
    estimatedPayRate: o.estimatedPayRate?.toString() ?? null,
    estimatedBillRate: o.estimatedBillRate?.toString() ?? null,
    estimatedMarginPerHour: marginPerHour(o.estimatedPayRate, o.estimatedBillRate),
    estimatedRevenue: o.estimatedRevenue?.toString() ?? null,
    probability: o.probability,
    expectedCloseDate: o.expectedCloseDate?.toISOString() ?? null,
    ownerLabel: o.ownerId ? (ownerLabels.get(o.ownerId) ?? null) : null,
    createdAt: o.createdAt.toISOString(),
    categoryId: o.categoryId,
    ownerId: o.ownerId,
    upcomingFollowUps: followUps.map((f) => ({
      id: f.id,
      type: f.type,
      status: f.status,
      dueDate: f.dueDate.toISOString(),
      notes: f.notes,
    })),
    recentActivity: activities.map((a) => ({
      id: a.id,
      type: a.type,
      subject: a.subject,
      body: a.body,
      performedByLabel: a.performedById ? (actorLabels.get(a.performedById) ?? "Unknown user") : "System",
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function createOpportunity(input: CreateOpportunityInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw AppError.notFound("Company not found");

  const opportunity = await scopedDb.opportunity.create({
    data: {
      tenantId: ctx.tenantId,
      companyId: input.companyId,
      title: input.title,
      stage: input.stage,
      categoryId: input.categoryId,
      estimatedWorkers: input.estimatedWorkers,
      estimatedPayRate: input.estimatedPayRate,
      estimatedBillRate: input.estimatedBillRate,
      estimatedRevenue: input.estimatedRevenue,
      probability: input.probability,
      expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : undefined,
      ownerId: input.ownerId,
    },
  });

  await logActivity({
    entityType: "company",
    entityId: input.companyId,
    type: "SYSTEM",
    subject: `Opportunity created: ${opportunity.title}`,
  });

  return opportunity;
}

export async function updateOpportunity(id: string, input: UpdateOpportunityInput) {
  const existing = await scopedDb.opportunity.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Opportunity not found");

  return scopedDb.opportunity.update({
    where: { id },
    data: {
      title: input.title,
      categoryId: input.categoryId,
      estimatedWorkers: input.estimatedWorkers,
      estimatedPayRate: input.estimatedPayRate,
      estimatedBillRate: input.estimatedBillRate,
      estimatedRevenue: input.estimatedRevenue,
      probability: input.probability,
      expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : undefined,
      ownerId: input.ownerId,
    },
  });
}

export async function updateOpportunityStage(id: string, stage: string) {
  const existing = await scopedDb.opportunity.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Opportunity not found");

  const opportunity = await scopedDb.opportunity.update({
    where: { id },
    data: { stage: stage as never },
  });

  await logActivity({
    entityType: "company",
    entityId: existing.companyId,
    type: "SYSTEM",
    subject: `Opportunity "${existing.title}" moved: ${existing.stage} → ${stage}`,
  });
  await logActivity({
    entityType: "opportunity",
    entityId: id,
    type: "SYSTEM",
    subject: `Stage changed: ${existing.stage} → ${stage}`,
  });

  return opportunity;
}

export async function getPipeline(): Promise<PipelineResponse> {
  const opportunities = await scopedDb.opportunity.findMany({
    where: { stage: { in: [...PIPELINE_STAGES] } },
    orderBy: [{ createdAt: "desc" }],
    include: { company: true, category: true },
  });

  const ownerLabels = await labelUsers(opportunities.filter((o) => o.ownerId).map((o) => o.ownerId!));

  const columns = PIPELINE_STAGES.map((stage) => {
    const inStage = opportunities.filter((o) => o.stage === stage);
    const totalValue = inStage.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

    return {
      stage,
      totalValue: totalValue.toFixed(2),
      opportunities: inStage.map((o) => ({
        id: o.id,
        title: o.title,
        companyId: o.companyId,
        companyName: o.company.name,
        stage: o.stage,
        categoryName: o.category?.name ?? null,
        estimatedWorkers: o.estimatedWorkers,
        estimatedPayRate: o.estimatedPayRate?.toString() ?? null,
        estimatedBillRate: o.estimatedBillRate?.toString() ?? null,
        estimatedMarginPerHour: marginPerHour(o.estimatedPayRate, o.estimatedBillRate),
        estimatedRevenue: o.estimatedRevenue?.toString() ?? null,
        probability: o.probability,
        expectedCloseDate: o.expectedCloseDate?.toISOString() ?? null,
        ownerLabel: o.ownerId ? (ownerLabels.get(o.ownerId) ?? null) : null,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  });

  return { columns };
}
