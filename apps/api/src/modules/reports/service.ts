/**
 * F9.11: Operational Reports -- agregados deterministas, tenant-scoped,
 * calculados con `groupBy`/`count` reales sobre datos ya persistidos por
 * F9.1-F9.10. NUNCA una métrica inventada, NUNCA una predicción
 * presentada como hecho -- cada número es un conteo real de registros
 * existentes en este preciso momento. Mismo patrón field-by-field de
 * permisos ya establecido por `dashboard/service.ts` (F6.8): cada bloque
 * se calcula solo si el caller trae el permiso real que ya gatea ese
 * recurso en su propio módulo, nunca un permiso "reports.*" inventado.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";

export interface OperationalReportSummary {
  generatedAt: string;
  onboardingByStatus?: Record<string, number>;
  checklistItemsByStatus?: Record<string, number>;
  complianceEvaluationsByStatus?: Record<string, number>;
  placementsByStatus?: Record<string, number>;
  assignmentsByStatus?: Record<string, number>;
  timeEntriesByStatus?: Record<string, number>;
  timeEntryFlagCounts?: { overtimeFlagged: number; discrepancyFlagged: number };
  shiftCount?: number;
  incidentsByStatus?: Record<string, number>;
  incidentsByType?: Record<string, number>;
  openIncidentCount?: number;
}

function countsByKey<K extends string>(groups: Array<{ [key: string]: unknown; _count: { _all: number } }>, key: string): Record<K, number> {
  const result: Record<string, number> = {};
  for (const g of groups) result[g[key] as string] = g._count._all;
  return result as Record<K, number>;
}

export async function getOperationalReport(): Promise<OperationalReportSummary> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);

  const canViewOnboarding = has("workers.view");
  // documents.view: mismo criterio ya establecido por dashboard/service.ts
  // (F6.8) para exponer visibilidad de compliance -- nunca un permiso
  // nuevo inventado para reportes.
  const canViewCompliance = has("documents.view");
  const canViewPlacements = has("assignments.view");
  const canViewAssignments = has("assignments.view");
  const canViewTimeEntries = has("timeEntries.view");
  const canViewShifts = has("shifts.view");
  const canViewIncidents = has("incidents.view");

  const [
    onboardingGroups,
    checklistGroups,
    complianceGroups,
    placementGroups,
    assignmentGroups,
    timeEntryGroups,
    overtimeFlaggedCount,
    discrepancyFlaggedCount,
    shiftCount,
    incidentStatusGroups,
    incidentTypeGroups,
  ] = await Promise.all([
    canViewOnboarding ? scopedDb.workerOnboarding.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewOnboarding ? scopedDb.documentChecklistItem.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewCompliance ? scopedDb.complianceRuleEvaluation.groupBy({ by: ["complianceStatus"], _count: { _all: true } }) : Promise.resolve(null),
    canViewPlacements ? scopedDb.placement.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewAssignments ? scopedDb.assignment.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewTimeEntries ? scopedDb.timeEntry.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewTimeEntries ? scopedDb.timeEntry.count({ where: { overtimeFlag: true } }) : Promise.resolve(null),
    canViewTimeEntries ? scopedDb.timeEntry.count({ where: { discrepancyFlag: true } }) : Promise.resolve(null),
    canViewShifts ? scopedDb.shift.count() : Promise.resolve(null),
    canViewIncidents ? scopedDb.operationalIncident.groupBy({ by: ["status"], _count: { _all: true } }) : Promise.resolve(null),
    canViewIncidents ? scopedDb.operationalIncident.groupBy({ by: ["type"], _count: { _all: true } }) : Promise.resolve(null),
  ]);

  const summary: OperationalReportSummary = { generatedAt: new Date().toISOString() };

  if (onboardingGroups !== null) summary.onboardingByStatus = countsByKey(onboardingGroups, "status");
  if (checklistGroups !== null) summary.checklistItemsByStatus = countsByKey(checklistGroups, "status");
  if (complianceGroups !== null) summary.complianceEvaluationsByStatus = countsByKey(complianceGroups, "complianceStatus");
  if (placementGroups !== null) summary.placementsByStatus = countsByKey(placementGroups, "status");
  if (assignmentGroups !== null) summary.assignmentsByStatus = countsByKey(assignmentGroups, "status");
  if (timeEntryGroups !== null) summary.timeEntriesByStatus = countsByKey(timeEntryGroups, "status");
  if (overtimeFlaggedCount !== null && discrepancyFlaggedCount !== null) {
    summary.timeEntryFlagCounts = { overtimeFlagged: overtimeFlaggedCount, discrepancyFlagged: discrepancyFlaggedCount };
  }
  if (shiftCount !== null) summary.shiftCount = shiftCount;
  if (incidentStatusGroups !== null) {
    summary.incidentsByStatus = countsByKey(incidentStatusGroups, "status");
    summary.openIncidentCount = (summary.incidentsByStatus.OPEN ?? 0) + (summary.incidentsByStatus.UNDER_REVIEW ?? 0) + (summary.incidentsByStatus.ACTION_REQUIRED ?? 0);
  }
  if (incidentTypeGroups !== null) summary.incidentsByType = countsByKey(incidentTypeGroups, "type");

  return summary;
}
