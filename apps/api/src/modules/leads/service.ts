import type {
  ConvertLeadInput,
  ConvertLeadResult,
  CreateLeadInput,
  LeadDetail,
  LeadListItem,
  LeadQuery,
  Paginated,
  UpdateLeadInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { labelUsers } from "../../core/user-labels";
import { AppError } from "../../core/errors";
import { evaluateBusinessIdentityGate } from "../ceo-intelligence/conversion-policy";

// F18: único chokepoint real de creación de Lead — REST API manual
// (router.ts), agentes (sales-tools.impl.ts) y conversión de Lead
// (convertLead, abajo) pasan todos por acá o por createOpportunity. Un
// caller nunca puede saltarse este gate porque no hay otra forma de
// crear un Lead/Opportunity con Company existente en el código.
async function assertCompanyCommerciallyEligible(companyId: string): Promise<void> {
  const company = await scopedDb.company.findUnique({ where: { id: companyId }, select: { commercialStatus: true, origin: true } });
  if (!company) throw AppError.notFound("Company not found");
  const gate = evaluateBusinessIdentityGate(company.commercialStatus, company.origin);
  if (!gate.allowed) throw AppError.badRequest(gate.reason);
}

async function nextFollowUpsFor(leadIds: string[]) {
  if (leadIds.length === 0) return new Map<string, { id: string; type: string; dueDate: Date }>();
  const followUps = await scopedDb.followUp.findMany({
    where: { entityType: "lead", entityId: { in: leadIds }, status: "PENDING" },
    orderBy: { dueDate: "asc" },
  });
  const map = new Map<string, (typeof followUps)[number]>();
  for (const f of followUps) {
    if (!map.has(f.entityId)) map.set(f.entityId, f);
  }
  return map;
}

export async function listLeads(query: LeadQuery): Promise<Paginated<LeadListItem>> {
  const rows = await scopedDb.lead.findMany({
    ...buildCursorArgs(query),
    where: {
      status: query.status,
      source: query.source,
      priority: query.priority,
      ownerId: query.assignedToId,
      industryId: query.industryId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { company: true, industry: true },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  const [ownerLabels, nextFollowUps] = await Promise.all([
    labelUsers(items.filter((l) => l.ownerId).map((l) => l.ownerId!)),
    nextFollowUpsFor(items.map((l) => l.id)),
  ]);

  return {
    items: items.map((lead) => ({
      id: lead.id,
      companyName: lead.company?.name ?? null,
      industryName: lead.industry?.name ?? null,
      city: lead.city,
      state: lead.state,
      source: lead.source,
      status: lead.status,
      priority: lead.priority,
      ownerLabel: lead.ownerId ? (ownerLabels.get(lead.ownerId) ?? null) : null,
      aiScore: lead.aiScore,
      nextFollowUp: (() => {
        const f = nextFollowUps.get(lead.id);
        return f ? { id: f.id, type: f.type, dueDate: f.dueDate.toISOString() } : null;
      })(),
      createdByAgentTaskId: lead.createdByAgentTaskId,
      createdAt: lead.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getLeadDetail(id: string): Promise<LeadDetail> {
  const lead = await scopedDb.lead.findUnique({
    where: { id },
    include: { company: true, industry: true },
  });
  if (!lead) throw AppError.notFound("Lead not found");

  const [followUps, activities, ownerLabels] = await Promise.all([
    scopedDb.followUp.findMany({
      where: { entityType: "lead", entityId: id, status: "PENDING" },
      orderBy: { dueDate: "asc" },
      take: 5,
    }),
    scopedDb.activity.findMany({
      where: { entityType: "lead", entityId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    labelUsers(lead.ownerId ? [lead.ownerId] : []),
  ]);

  const actorIds = activities.filter((a) => a.performedById).map((a) => a.performedById!);
  const actorLabels = await labelUsers(actorIds);

  return {
    id: lead.id,
    companyName: lead.company?.name ?? null,
    industryName: lead.industry?.name ?? null,
    city: lead.city,
    state: lead.state,
    source: lead.source,
    status: lead.status,
    priority: lead.priority,
    ownerLabel: lead.ownerId ? (ownerLabels.get(lead.ownerId) ?? null) : null,
    aiScore: lead.aiScore,
    nextFollowUp: followUps[0]
      ? { id: followUps[0].id, type: followUps[0].type, dueDate: followUps[0].dueDate.toISOString() }
      : null,
    createdByAgentTaskId: lead.createdByAgentTaskId,
    createdAt: lead.createdAt.toISOString(),
    companyId: lead.companyId,
    industryId: lead.industryId,
    aiScoreReason: lead.aiScoreReason,
    notes: lead.notes,
    ownerId: lead.ownerId,
    upcomingFollowUps: followUps.map((f) => ({
      id: f.id,
      type: f.type,
      status: f.status,
      dueDate: f.dueDate.toISOString(),
      notes: f.notes,
      createdByAgentTaskId: f.createdByAgentTaskId,
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

export async function createLead(input: CreateLeadInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (input.companyId) await assertCompanyCommerciallyEligible(input.companyId);

  const lead = await scopedDb.lead.create({
    data: {
      tenantId: ctx.tenantId,
      companyId: input.companyId,
      industryId: input.industryId,
      city: input.city,
      state: input.state,
      source: input.source,
      priority: input.priority,
      status: input.status ?? "NEW",
      ownerId: input.ownerId,
      aiScore: input.aiScore,
      aiScoreReason: input.aiScoreReason,
      notes: input.notes,
    },
  });

  await logActivity({ entityType: "lead", entityId: lead.id, type: "SYSTEM", subject: "Lead created" });

  return lead;
}

export async function updateLead(id: string, input: UpdateLeadInput) {
  const existing = await scopedDb.lead.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Lead not found");

  const lead = await scopedDb.lead.update({
    where: { id },
    data: {
      companyId: input.companyId,
      industryId: input.industryId,
      city: input.city,
      state: input.state,
      source: input.source,
      priority: input.priority,
      status: input.status,
      ownerId: input.ownerId,
      aiScore: input.aiScore,
      aiScoreReason: input.aiScoreReason,
      notes: input.notes,
    },
  });

  if (input.status && input.status !== existing.status) {
    await logActivity({
      entityType: "lead",
      entityId: id,
      type: "SYSTEM",
      subject: `Status changed: ${existing.status} → ${input.status}`,
    });
  }

  return lead;
}

export async function convertLead(id: string, input: ConvertLeadInput): Promise<ConvertLeadResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const lead = await scopedDb.lead.findUnique({ where: { id } });
  if (!lead) throw AppError.notFound("Lead not found");
  if (lead.status === "CONVERTED") throw AppError.badRequest("Lead is already converted");

  let companyId = lead.companyId;

  if (!companyId) {
    if (!input.newCompanyName) {
      throw AppError.badRequest("newCompanyName is required: this lead has no company yet");
    }
    if (!lead.industryId) {
      throw AppError.badRequest("Lead has no industry set — required to create a new Company");
    }
    const company = await scopedDb.company.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.newCompanyName,
        industryId: lead.industryId,
        status: "PROSPECT",
        city: lead.city,
        state: lead.state,
      },
    });
    companyId = company.id;
    await logActivity({ entityType: "company", entityId: company.id, type: "SYSTEM", subject: "Company created from converted lead" });
  } else {
    // F18: Company preexistente -- puede ser un candidato de Discovery
    // sin validar (ver Company.commercialStatus), a diferencia de la
    // rama de arriba (Company recién creada a mano por un humano acá
    // mismo, que nace COMMERCIAL_VALIDATED por default). Nunca se
    // convierte un Lead de una empresa así hasta que se reclasifique.
    await assertCompanyCommerciallyEligible(companyId);
    const company = await scopedDb.company.findUnique({ where: { id: companyId } });
    if (company && company.status === "LEAD") {
      await scopedDb.company.update({ where: { id: companyId }, data: { status: "PROSPECT" } });
    }
  }

  const opportunity = await scopedDb.opportunity.create({
    data: {
      tenantId: ctx.tenantId,
      companyId,
      title: input.opportunity.title,
      categoryId: input.opportunity.categoryId,
      estimatedWorkers: input.opportunity.estimatedWorkers,
      estimatedPayRate: input.opportunity.estimatedPayRate,
      estimatedBillRate: input.opportunity.estimatedBillRate,
      estimatedRevenue: input.opportunity.estimatedRevenue,
      probability: input.opportunity.probability,
      expectedCloseDate: input.opportunity.expectedCloseDate
        ? new Date(input.opportunity.expectedCloseDate)
        : undefined,
      ownerId: lead.ownerId,
    },
  });

  await scopedDb.lead.update({ where: { id }, data: { status: "CONVERTED", companyId } });

  await logActivity({
    entityType: "lead",
    entityId: id,
    type: "SYSTEM",
    subject: `Converted to Opportunity: ${opportunity.title}`,
  });
  await logActivity({
    entityType: "company",
    entityId: companyId,
    type: "SYSTEM",
    subject: `New Opportunity from converted lead: ${opportunity.title}`,
  });

  return { companyId, opportunityId: opportunity.id };
}
