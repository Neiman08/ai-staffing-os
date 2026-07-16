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

// F6.8: cada bloque de métricas se calcula solo si el caller trae el
// permiso real que ya gatea ese recurso en su propio módulo — mismo
// principio que requirePermission(), aplicado campo por campo en vez de
// endpoint por endpoint. Nunca se calcula un agregado que el response no
// va a poder incluir (evita trabajo innecesario, no solo evita filtrar
// el JSON después).
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);

  const canViewWorkers = has("workers.view");
  const canViewCandidates = has("candidates.view");
  const canViewJobOrders = has("jobOrders.view");
  // documents.view: mismo permiso que ya gatea GET /compliance/documents
  // (apps/api/src/modules/compliance/router.ts) — las alertas de
  // compliance son parte de esa misma superficie, nunca un permiso nuevo.
  const canViewCompliance = has("documents.view");
  const canViewAssignments = has("assignments.view");
  // Visibilidad financiera real: los únicos permisos existentes que ya
  // exponen billRate/payRate/margen agregado en otros módulos
  // (payrollRuns, invoices) — nunca un permiso "dashboard.financial"
  // inventado para esta feature.
  const canViewFinancials = has("payrollRuns.view") || has("invoices.view");

  const since14 = daysAgo(13);
  const since7 = daysAgo(6);

  const [
    activeWorkers,
    candidateGroups,
    jobOrderAggregates,
    openJobOrders,
    unresolvedComplianceAlerts,
    recentAlerts,
    workerComplianceGroups,
    assignmentGroups,
    timeEntries14d,
  ] = await Promise.all([
    canViewWorkers ? scopedDb.worker.count({ where: { status: { not: "TERMINATED" } } }) : Promise.resolve(null),
    canViewCandidates ? scopedDb.candidate.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewJobOrders
      ? scopedDb.jobOrder.aggregate({
          _sum: { workersNeeded: true, workersFilled: true },
          _count: { _all: true },
          where: { status: { not: "CANCELLED" } },
        })
      : Promise.resolve(null),
    canViewJobOrders
      ? scopedDb.jobOrder.count({ where: { status: { in: ["OPEN", "PARTIALLY_FILLED"] } } })
      : Promise.resolve(null),
    canViewCompliance ? scopedDb.complianceAlert.count({ where: { resolvedAt: null } }) : Promise.resolve(null),
    canViewCompliance
      ? scopedDb.complianceAlert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 5 })
      : Promise.resolve(null),
    canViewCompliance ? scopedDb.worker.groupBy({ by: ["complianceStatus"], _count: { _all: true } }) : Promise.resolve(null),
    canViewAssignments ? scopedDb.assignment.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewFinancials
      ? scopedDb.timeEntry.findMany({ where: { date: { gte: since14 } }, include: { assignment: true } })
      : Promise.resolve(null),
  ]);

  const summary: DashboardSummary = {};

  if (activeWorkers !== null) summary.activeWorkers = activeWorkers;

  if (candidateGroups !== null) {
    const candidatesByStatus: Record<string, number> = {};
    for (const group of candidateGroups) candidatesByStatus[group.status] = group._count._all;
    summary.candidatesByStatus = candidatesByStatus;
  }

  if (openJobOrders !== null) summary.openJobOrders = openJobOrders;
  if (jobOrderAggregates !== null) {
    const needed = jobOrderAggregates._sum.workersNeeded ?? 0;
    const filled = jobOrderAggregates._sum.workersFilled ?? 0;
    summary.fillRate = Number((needed > 0 ? filled / needed : 0).toFixed(4));
  }

  if (unresolvedComplianceAlerts !== null) summary.unresolvedComplianceAlerts = unresolvedComplianceAlerts;
  if (recentAlerts !== null) {
    summary.recentAlerts = recentAlerts.map((alert) => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      createdAt: alert.createdAt.toISOString(),
    }));
  }
  if (workerComplianceGroups !== null) {
    const workersByComplianceStatus: Record<string, number> = {};
    for (const group of workerComplianceGroups) workersByComplianceStatus[group.complianceStatus] = group._count._all;
    summary.workersByComplianceStatus = workersByComplianceStatus;
  }

  if (assignmentGroups !== null) {
    const assignmentsByStatus: Record<string, number> = {};
    for (const group of assignmentGroups) assignmentsByStatus[group.status] = group._count._all;
    summary.assignmentsByStatus = assignmentsByStatus;
  }

  if (timeEntries14d !== null) {
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

    summary.weeklyHours = Number(weeklyHours.toFixed(2));
    summary.weeklyGrossMargin = Number(weeklyGrossMargin.toFixed(2));
    summary.billableRevenuePeriod = Number(billableRevenuePeriod.toFixed(2));
    summary.dailySeries = Array.from(dailyBuckets.entries()).map(([date, v]) => ({
      date,
      hours: Number(v.hours.toFixed(2)),
      margin: Number(v.margin.toFixed(2)),
    }));
  }

  return summary;
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
