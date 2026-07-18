/**
 * F11.3: Executive Dashboard -- une recruiting/comercial/operaciones/
 * financiero en una sola respuesta, reutilizando el cálculo real ya
 * hecho por dashboard/service.ts, reports/service.ts y
 * revenue/service.ts (nunca una query nueva que duplique lo que esos
 * tres módulos ya calculan correctamente). Cada campo se incluye solo si
 * el módulo de origen ya lo incluyó para este caller -- la omisión de
 * campo por permiso (F6.8) de los tres módulos de origen se propaga acá
 * sin volver a chequear el mismo permiso.
 *
 * Excepción: revenue/service.ts no hace omisión de campo por sí mismo
 * (ver docs/PRE_F11_FULL_AUDIT_FINDINGS.md F-06 -- se corrigió a nivel de
 * ruta con requireInternalIdentity(), nunca tuvo un chequeo de permiso
 * interno). Acá sí se gatea explícitamente con el mismo permiso real que
 * ya gatea las páginas de Leads/Opportunities, para que el bloque
 * "commercial" del executive dashboard respete el mismo criterio que el
 * resto -- nunca se le muestra pipeline a un caller sin leads.view ni
 * opportunities.view.
 */
import type { ExecutiveDashboard } from "@ai-staffing-os/shared";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { getDashboardSummary } from "../dashboard/service";
import { getOperationalReport } from "../reports/service";
import { getRevenueSummary } from "../revenue/service";

export async function getExecutiveDashboard(): Promise<ExecutiveDashboard> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);
  const canViewCommercial = has("leads.view") || has("opportunities.view");

  const [dashboardSummary, operationalReport, revenueSummary] = await Promise.all([
    getDashboardSummary(),
    getOperationalReport(),
    canViewCommercial ? getRevenueSummary() : Promise.resolve(null),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    recruiting: {
      activeWorkers: dashboardSummary.activeWorkers,
      openJobOrders: dashboardSummary.openJobOrders,
      fillRate: dashboardSummary.fillRate,
      candidatesByStatus: dashboardSummary.candidatesByStatus,
    },
    commercial: revenueSummary
      ? {
          newLeadsThisWeek: revenueSummary.newLeadsThisWeek,
          openOpportunities: revenueSummary.openOpportunities,
          pipelineValue: revenueSummary.pipelineValue,
          scheduledMeetings: revenueSummary.scheduledMeetings,
        }
      : {},
    operations: {
      assignmentsByStatus: dashboardSummary.assignmentsByStatus,
      unresolvedComplianceAlerts: dashboardSummary.unresolvedComplianceAlerts,
      openIncidentCount: operationalReport.openIncidentCount,
    },
    financial: {
      weeklyHours: dashboardSummary.weeklyHours,
      weeklyGrossMargin: dashboardSummary.weeklyGrossMargin,
      billableRevenuePeriod: dashboardSummary.billableRevenuePeriod,
      dailySeries: dashboardSummary.dailySeries,
    },
  };
}
