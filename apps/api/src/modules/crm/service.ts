import type {
  CompanyDetail,
  CompanyListItem,
  ContactInput,
  ContactListItem,
  ContactQuery,
  CreateCompanyInput,
  Paginated,
  PaginationQuery,
  UpdateCompanyInput,
  UpdateContactInput,
} from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { AppError } from "../../core/errors";

const OPEN_OPPORTUNITY_STAGES = ["MEETING_SCHEDULED", "PROPOSAL_SENT", "NEGOTIATION"] as const;

async function attachCompanyComputedFields(companyIds: string[]) {
  if (companyIds.length === 0) {
    return { nextFollowUps: new Map(), lastActivities: new Map(), openOpportunityCounts: new Map() };
  }

  const [followUps, activities, opportunityCounts] = await Promise.all([
    scopedDb.followUp.findMany({
      where: { entityType: "company", entityId: { in: companyIds }, status: "PENDING" },
      orderBy: { dueDate: "asc" },
    }),
    scopedDb.activity.findMany({
      where: { entityType: "company", entityId: { in: companyIds } },
      orderBy: { createdAt: "desc" },
    }),
    scopedDb.opportunity.groupBy({
      by: ["companyId"],
      where: { companyId: { in: companyIds }, stage: { in: [...OPEN_OPPORTUNITY_STAGES] } },
      _count: { _all: true },
    }),
  ]);

  const nextFollowUps = new Map<string, (typeof followUps)[number]>();
  for (const f of followUps) {
    if (!nextFollowUps.has(f.entityId)) nextFollowUps.set(f.entityId, f);
  }

  const lastActivities = new Map<string, (typeof activities)[number]>();
  for (const a of activities) {
    if (!lastActivities.has(a.entityId)) lastActivities.set(a.entityId, a);
  }

  const openOpportunityCounts = new Map(opportunityCounts.map((o) => [o.companyId, o._count._all]));

  return { nextFollowUps, lastActivities, openOpportunityCounts };
}

export async function listCompanies(query: PaginationQuery): Promise<Paginated<CompanyListItem>> {
  const rows = await scopedDb.company.findMany({
    ...buildCursorArgs(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      industry: true,
      _count: { select: { contacts: true } },
    },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  const { nextFollowUps, lastActivities, openOpportunityCounts } = await attachCompanyComputedFields(
    items.map((c) => c.id),
  );

  return {
    items: items.map((company) => ({
      id: company.id,
      name: company.name,
      status: company.status,
      industryName: company.industry.name,
      city: company.city,
      state: company.state,
      estimatedSize: company.estimatedSize,
      commercialScore: company.commercialScore,
      contactCount: company._count.contacts,
      openOpportunityCount: openOpportunityCounts.get(company.id) ?? 0,
      nextFollowUp: (() => {
        const f = nextFollowUps.get(company.id);
        return f ? { id: f.id, type: f.type, dueDate: f.dueDate.toISOString() } : null;
      })(),
      lastActivityAt: lastActivities.get(company.id)?.createdAt.toISOString() ?? null,
      createdAt: company.createdAt.toISOString(),
      origin: company.origin,
      sourceUrl: company.sourceUrl,
      verificationStatus: company.verificationStatus,
      confidenceScore: company.confidenceScore,
    })),
    nextCursor,
  };
}

export async function getCompanyDetail(id: string): Promise<CompanyDetail> {
  const company = await scopedDb.company.findUnique({
    where: { id },
    include: {
      industry: true,
      possibleCategories: true,
      _count: { select: { contacts: true } },
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      opportunities: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!company) throw AppError.notFound("Company not found");

  const [followUps, activities, openOpportunityCount] = await Promise.all([
    scopedDb.followUp.findMany({
      where: { entityType: "company", entityId: id, status: "PENDING" },
      orderBy: { dueDate: "asc" },
      take: 5,
    }),
    scopedDb.activity.findMany({
      where: { entityType: "company", entityId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    scopedDb.opportunity.count({
      where: { companyId: id, stage: { in: [...OPEN_OPPORTUNITY_STAGES] } },
    }),
  ]);

  const actorIds = activities.filter((a) => a.performedById).map((a) => a.performedById!);
  const actors = actorIds.length
    ? await scopedDb.user.findMany({ where: { id: { in: actorIds } } })
    : [];
  const actorMap = new Map(actors.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

  return {
    id: company.id,
    name: company.name,
    status: company.status,
    industryName: company.industry.name,
    city: company.city,
    state: company.state,
    estimatedSize: company.estimatedSize,
    commercialScore: company.commercialScore,
    contactCount: company._count.contacts,
    openOpportunityCount,
    nextFollowUp: followUps[0]
      ? { id: followUps[0].id, type: followUps[0].type, dueDate: followUps[0].dueDate.toISOString() }
      : null,
    lastActivityAt: activities[0]?.createdAt.toISOString() ?? null,
    createdAt: company.createdAt.toISOString(),
    origin: company.origin,
    sourceUrl: company.sourceUrl,
    verificationStatus: company.verificationStatus,
    confidenceScore: company.confidenceScore,
    website: company.website,
    phone: company.phone,
    email: company.email,
    commercialScoreReason: company.commercialScoreReason,
    notes: company.notes,
    possibleCategoryNames: company.possibleCategories.map((c) => c.name),
    contacts: company.contacts.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      title: c.title,
      linkedinUrl: c.linkedinUrl,
      decisionRole: c.decisionRole,
      isPrimary: c.isPrimary,
      source: c.source,
      confidenceScore: c.confidenceScore,
      discoveredAt: c.discoveredAt?.toISOString() ?? null,
      verificationStatus: c.verificationStatus,
    })),
    opportunities: company.opportunities.map((o) => ({
      id: o.id,
      title: o.title,
      stage: o.stage,
      estimatedRevenue: o.estimatedRevenue?.toString() ?? null,
      probability: o.probability,
      createdByAgentTaskId: o.createdByAgentTaskId,
    })),
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
      performedByLabel: a.performedById ? (actorMap.get(a.performedById) ?? "Unknown user") : "System",
      createdAt: a.createdAt.toISOString(),
    })),
    discoveredAt: company.discoveredAt?.toISOString() ?? null,
    discoveredByAgentTaskId: company.discoveredByAgentTaskId,
    lastVerifiedAt: company.lastVerifiedAt?.toISOString() ?? null,
  };
}

export async function createCompany(input: CreateCompanyInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const company = await scopedDb.company.create({
    data: {
      tenantId: ctx.tenantId,
      name: input.name,
      industryId: input.industryId,
      status: input.status ?? "LEAD",
      website: input.website,
      phone: input.phone,
      city: input.city,
      state: input.state,
      estimatedSize: input.estimatedSize,
      commercialScore: input.commercialScore,
      notes: input.notes,
      possibleCategories: input.possibleCategoryIds
        ? { connect: input.possibleCategoryIds.map((id) => ({ id })) }
        : undefined,
      origin: "MANUAL", // F4.5: transparencia de origen
    },
  });

  await logActivity({
    entityType: "company",
    entityId: company.id,
    type: "SYSTEM",
    subject: "Company created",
  });

  return company;
}

export async function updateCompany(id: string, input: UpdateCompanyInput) {
  const existing = await scopedDb.company.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Company not found");

  const company = await scopedDb.company.update({
    where: { id },
    data: {
      name: input.name,
      industryId: input.industryId,
      status: input.status,
      website: input.website,
      phone: input.phone,
      city: input.city,
      state: input.state,
      estimatedSize: input.estimatedSize,
      commercialScore: input.commercialScore,
      notes: input.notes,
      possibleCategories: input.possibleCategoryIds
        ? { set: input.possibleCategoryIds.map((cid) => ({ id: cid })) }
        : undefined,
    },
  });

  if (input.status && input.status !== existing.status) {
    await logActivity({
      entityType: "company",
      entityId: id,
      type: "SYSTEM",
      subject: `Status changed: ${existing.status} → ${input.status}`,
    });
  }

  return company;
}

export async function listContacts(query: ContactQuery): Promise<Paginated<ContactListItem>> {
  const rows = await scopedDb.contact.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit: query.limit ?? 20 }),
    where: {
      companyId: query.companyId,
      decisionRole: query.decisionRole,
      verificationStatus: query.verificationStatus,
      confidenceScore: query.minConfidence != null ? { gte: query.minConfidence } : undefined,
      company: {
        state: query.companyState,
        industry: query.industryName ? { name: query.industryName } : undefined,
        name: query.companyName ? { contains: query.companyName, mode: "insensitive" } : undefined,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { company: { include: { industry: true } } },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit ?? 20);

  return {
    items: items.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      title: c.title,
      linkedinUrl: c.linkedinUrl,
      decisionRole: c.decisionRole,
      isPrimary: c.isPrimary,
      source: c.source,
      confidenceScore: c.confidenceScore,
      discoveredAt: c.discoveredAt?.toISOString() ?? null,
      verificationStatus: c.verificationStatus,
      companyId: c.companyId,
      companyName: c.company.name,
      industryName: c.company.industry.name,
      companyState: c.company.state,
    })),
    nextCursor,
  };
}

export async function createContact(companyId: string, input: ContactInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const company = await scopedDb.company.findUnique({ where: { id: companyId } });
  if (!company) throw AppError.notFound("Company not found");

  const contact = await scopedDb.contact.create({
    data: {
      tenantId: ctx.tenantId,
      companyId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      title: input.title,
      linkedinUrl: input.linkedinUrl,
      decisionRole: input.decisionRole,
      isPrimary: input.isPrimary ?? false,
    },
  });

  await logActivity({
    entityType: "company",
    entityId: companyId,
    type: "SYSTEM",
    subject: `Contact added: ${contact.firstName} ${contact.lastName}`,
  });

  return contact;
}

export async function updateContact(id: string, input: UpdateContactInput) {
  const existing = await scopedDb.contact.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Contact not found");

  return scopedDb.contact.update({
    where: { id },
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      title: input.title,
      linkedinUrl: input.linkedinUrl,
      decisionRole: input.decisionRole,
      isPrimary: input.isPrimary,
    },
  });
}

export async function deleteContact(id: string): Promise<void> {
  const existing = await scopedDb.contact.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Contact not found");
  await scopedDb.contact.delete({ where: { id } });
}
