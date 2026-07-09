import type { RevenueIntelligence, RevenueSummary } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";

const OPEN_STAGES = ["MEETING_SCHEDULED", "PROPOSAL_SENT", "NEGOTIATION"] as const;
const CONTACT_ACTIVITY_TYPES = ["CALL", "EMAIL", "MEETING"] as const;

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

export async function getRevenueSummary(): Promise<RevenueSummary> {
  const [
    newLeadsThisWeek,
    contactedActivities,
    pendingFollowUps,
    openOpportunities,
    scheduledMeetings,
    companies,
  ] = await Promise.all([
    scopedDb.lead.count({ where: { createdAt: { gte: daysAgo(7) } } }),
    scopedDb.activity.findMany({
      where: { entityType: "company", type: { in: [...CONTACT_ACTIVITY_TYPES] }, createdAt: { gte: daysAgo(30) } },
      select: { entityId: true },
    }),
    scopedDb.followUp.count({ where: { status: "PENDING" } }),
    scopedDb.opportunity.findMany({
      where: { stage: { in: [...OPEN_STAGES] } },
      select: { estimatedRevenue: true },
    }),
    scopedDb.followUp.count({ where: { type: "MEETING", status: "PENDING", dueDate: { gte: new Date() } } }),
    scopedDb.company.findMany({ include: { industry: true } }),
  ]);

  const pipelineValue = openOpportunities.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);

  const industryCounts = new Map<string, number>();
  const stateCounts = new Map<string, number>();
  for (const c of companies) {
    industryCounts.set(c.industry.name, (industryCounts.get(c.industry.name) ?? 0) + 1);
    if (c.state) stateCounts.set(c.state, (stateCounts.get(c.state) ?? 0) + 1);
  }

  return {
    newLeadsThisWeek,
    companiesContacted: new Set(contactedActivities.map((a) => a.entityId)).size,
    pendingFollowUps,
    openOpportunities: openOpportunities.length,
    pipelineValue: pipelineValue.toFixed(2),
    scheduledMeetings,
    companiesByIndustry: [...industryCounts.entries()]
      .map(([industryName, count]) => ({ industryName, count }))
      .sort((a, b) => b.count - a.count),
    companiesByState: [...stateCounts.entries()]
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function getRevenueIntelligence(): Promise<RevenueIntelligence> {
  const [wonOpportunities, openOpportunitiesRaw, leads, clients, allOpportunities] = await Promise.all([
    scopedDb.opportunity.findMany({
      where: { stage: "WON" },
      include: { company: { include: { industry: true } } },
    }),
    scopedDb.opportunity.findMany({
      where: { stage: { in: [...OPEN_STAGES] } },
      include: { company: true },
      orderBy: { estimatedRevenue: "desc" },
      take: 5,
    }),
    scopedDb.lead.findMany({
      where: { status: { notIn: ["CONVERTED", "UNQUALIFIED"] } },
      include: { company: true },
    }),
    scopedDb.company.findMany({ where: { status: "CLIENT" } }),
    scopedDb.opportunity.findMany({ where: { stage: { in: [...OPEN_STAGES] } } }),
  ]);

  const byIndustry = new Map<string, { wonOpportunities: number; wonRevenue: number }>();
  const byState = new Map<string, { wonOpportunities: number; wonRevenue: number }>();
  for (const o of wonOpportunities) {
    const revenue = Number(o.estimatedRevenue ?? 0);
    const industryName = o.company.industry.name;
    const state = o.company.state;

    const industryEntry = byIndustry.get(industryName) ?? { wonOpportunities: 0, wonRevenue: 0 };
    industryEntry.wonOpportunities += 1;
    industryEntry.wonRevenue += revenue;
    byIndustry.set(industryName, industryEntry);

    if (state) {
      const stateEntry = byState.get(state) ?? { wonOpportunities: 0, wonRevenue: 0 };
      stateEntry.wonOpportunities += 1;
      stateEntry.wonRevenue += revenue;
      byState.set(state, stateEntry);
    }
  }

  // Leads without an active follow-up, older than 3 days (grace period for brand-new leads).
  const leadIds = leads.map((l) => l.id);
  const activeFollowUpLeadIds = leadIds.length
    ? new Set(
        (
          await scopedDb.followUp.findMany({
            where: { entityType: "lead", entityId: { in: leadIds }, status: "PENDING" },
            select: { entityId: true },
          })
        ).map((f) => f.entityId),
      )
    : new Set<string>();

  const now = new Date();
  const leadsWithoutFollowUp = leads
    .filter((l) => !activeFollowUpLeadIds.has(l.id) && daysBetween(l.createdAt, now) >= 3)
    .map((l) => ({
      id: l.id,
      companyName: l.company?.name ?? null,
      status: l.status,
      daysSinceLastActivity: daysBetween(l.createdAt, now),
    }))
    .sort((a, b) => b.daysSinceLastActivity - a.daysSinceLastActivity)
    .slice(0, 10);

  // Dormant clients: CLIENT companies with no Activity in the last 60 days.
  const clientIds = clients.map((c) => c.id);
  const recentActivityByCompany = clientIds.length
    ? await scopedDb.activity.findMany({
        where: { entityType: "company", entityId: { in: clientIds } },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, createdAt: true },
      })
    : [];
  const lastActivityMap = new Map<string, Date>();
  for (const a of recentActivityByCompany) {
    if (!lastActivityMap.has(a.entityId)) lastActivityMap.set(a.entityId, a.createdAt);
  }
  const dormantClients = clients
    .map((c) => {
      const last = lastActivityMap.get(c.id) ?? c.createdAt;
      return { id: c.id, name: c.name, daysSinceLastActivity: daysBetween(last, now) };
    })
    .filter((c) => c.daysSinceLastActivity >= 60)
    .sort((a, b) => b.daysSinceLastActivity - a.daysSinceLastActivity)
    .slice(0, 10);

  const pipelineByStage = OPEN_STAGES.map((stage) => {
    const inStage = allOpportunities.filter((o) => o.stage === stage);
    const totalValue = inStage.reduce((sum, o) => sum + Number(o.estimatedRevenue ?? 0), 0);
    const weightedValue = inStage.reduce(
      (sum, o) => sum + (Number(o.estimatedRevenue ?? 0) * (o.probability ?? 0)) / 100,
      0,
    );
    return { stage, count: inStage.length, totalValue: totalValue.toFixed(2), weightedValue: weightedValue.toFixed(2) };
  });

  return {
    topIndustries: [...byIndustry.entries()]
      .map(([industryName, v]) => ({ industryName, wonOpportunities: v.wonOpportunities, wonRevenue: v.wonRevenue.toFixed(2) }))
      .sort((a, b) => Number(b.wonRevenue) - Number(a.wonRevenue))
      .slice(0, 5),
    topStates: [...byState.entries()]
      .map(([state, v]) => ({ state, wonOpportunities: v.wonOpportunities, wonRevenue: v.wonRevenue.toFixed(2) }))
      .sort((a, b) => Number(b.wonRevenue) - Number(a.wonRevenue))
      .slice(0, 5),
    biggestOpportunities: openOpportunitiesRaw.map((o) => ({
      id: o.id,
      title: o.title,
      companyName: o.company.name,
      estimatedRevenue: o.estimatedRevenue?.toString() ?? null,
      stage: o.stage,
    })),
    leadsWithoutFollowUp,
    dormantClients,
    pipelineByStage,
  };
}
