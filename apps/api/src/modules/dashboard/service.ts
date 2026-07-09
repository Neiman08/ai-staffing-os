import type { AuditLogItem, DashboardSummary, NotificationsSummary } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = startOfDay(new Date());
  d.setDate(d.getDate() - n);
  return d;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const since14 = daysAgo(13);
  const since7 = daysAgo(6);

  const [
    activeWorkers,
    candidateGroups,
    jobOrderAggregates,
    openJobOrders,
    unresolvedComplianceAlerts,
    timeEntries14d,
    recentAlerts,
  ] = await Promise.all([
    scopedDb.worker.count({ where: { status: { not: "TERMINATED" } } }),
    scopedDb.candidate.groupBy({ by: ["status"], _count: { _all: true } }),
    scopedDb.jobOrder.aggregate({
      _sum: { workersNeeded: true, workersFilled: true },
      _count: { _all: true },
      where: { status: { not: "CANCELLED" } },
    }),
    scopedDb.jobOrder.count({ where: { status: { in: ["OPEN", "PARTIALLY_FILLED"] } } }),
    scopedDb.complianceAlert.count({ where: { resolvedAt: null } }),
    scopedDb.timeEntry.findMany({
      where: { date: { gte: since14 } },
      include: { assignment: true },
    }),
    scopedDb.complianceAlert.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const candidatesByStatus: Record<string, number> = {};
  for (const group of candidateGroups) {
    candidatesByStatus[group.status] = group._count._all;
  }

  const needed = jobOrderAggregates._sum.workersNeeded ?? 0;
  const filled = jobOrderAggregates._sum.workersFilled ?? 0;
  const fillRate = needed > 0 ? filled / needed : 0;

  const dailyBuckets = new Map<string, { hours: number; margin: number }>();
  for (let i = 0; i < 14; i++) {
    dailyBuckets.set(dateKey(daysAgo(13 - i)), { hours: 0, margin: 0 });
  }

  let weeklyHours = 0;
  let weeklyGrossMargin = 0;
  let billableRevenuePeriod = 0;

  for (const entry of timeEntries14d) {
    const totalHours = Number(entry.regularHours) + Number(entry.overtimeHours) + Number(entry.doubleHours);
    const billRate = Number(entry.assignment.billRate);
    const payRate = Number(entry.assignment.payRate);
    const margin = totalHours * (billRate - payRate);
    const key = dateKey(startOfDay(entry.date));

    const bucket = dailyBuckets.get(key);
    if (bucket) {
      bucket.hours += totalHours;
      bucket.margin += margin;
    }

    if (entry.date >= since7) {
      weeklyHours += totalHours;
      weeklyGrossMargin += margin;
      billableRevenuePeriod += totalHours * billRate;
    }
  }

  return {
    activeWorkers,
    candidatesByStatus,
    openJobOrders,
    fillRate: Number(fillRate.toFixed(4)),
    unresolvedComplianceAlerts,
    weeklyHours: Number(weeklyHours.toFixed(2)),
    weeklyGrossMargin: Number(weeklyGrossMargin.toFixed(2)),
    billableRevenuePeriod: Number(billableRevenuePeriod.toFixed(2)),
    dailySeries: Array.from(dailyBuckets.entries()).map(([date, v]) => ({
      date,
      hours: Number(v.hours.toFixed(2)),
      margin: Number(v.margin.toFixed(2)),
    })),
    recentAlerts: recentAlerts.map((alert) => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      createdAt: alert.createdAt.toISOString(),
    })),
  };
}

export async function getRecentAuditLog(limit = 15): Promise<AuditLogItem[]> {
  const entries = await scopedDb.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const userIds = entries.filter((e) => e.actorType === "HUMAN").map((e) => e.actorId);
  const agentInstanceIds = entries.filter((e) => e.actorType === "AGENT").map((e) => e.actorId);

  const [users, agentInstances] = await Promise.all([
    userIds.length ? scopedDb.user.findMany({ where: { id: { in: userIds } } }) : [],
    agentInstanceIds.length
      ? scopedDb.agentInstance.findMany({ where: { id: { in: agentInstanceIds } }, include: { definition: true } })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  const agentMap = new Map(agentInstances.map((a) => [a.id, a.definition.name]));

  return entries.map((entry) => ({
    id: entry.id,
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorLabel:
      entry.actorType === "HUMAN"
        ? (userMap.get(entry.actorId) ?? "Unknown user")
        : entry.actorType === "AGENT"
          ? (agentMap.get(entry.actorId) ?? "Unknown agent")
          : "System",
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    createdAt: entry.createdAt.toISOString(),
  }));
}

export async function getNotificationsSummary(): Promise<NotificationsSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const notifications = await scopedDb.notification.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  return {
    unreadCount,
    items: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}
