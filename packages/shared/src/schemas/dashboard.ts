import { z } from "zod";

export const dashboardDailyPointSchema = z.object({
  date: z.string(),
  hours: z.number(),
  margin: z.number(),
});

export const dashboardAlertSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
  createdAt: z.string(),
});

// F6.8: cada campo es opcional — el backend omite (no calcula) los que
// el permiso del caller no habilita, en vez de calcularlos y ocultarlos
// solo en el frontend (RBAC real por métrica, no solo cosmético). Un
// campo ausente significa "tu rol no tiene el permiso que lo respalda",
// nunca "el dato es cero" — ver apps/api/src/modules/dashboard/service.ts.
export const dashboardSummarySchema = z.object({
  // workers.view
  activeWorkers: z.number().optional(),
  // candidates.view
  candidatesByStatus: z.record(z.string(), z.number()).optional(),
  // jobOrders.view
  openJobOrders: z.number().optional(),
  fillRate: z.number().optional(),
  // documents.view (mismo permiso que ya gatea GET /compliance/documents)
  unresolvedComplianceAlerts: z.number().optional(),
  recentAlerts: z.array(dashboardAlertSchema).optional(),
  workersByComplianceStatus: z.record(z.string(), z.number()).optional(),
  // assignments.view
  assignmentsByStatus: z.record(z.string(), z.number()).optional(),
  // payrollRuns.view o invoices.view (visibilidad financiera real)
  weeklyHours: z.number().optional(),
  weeklyGrossMargin: z.number().optional(),
  billableRevenuePeriod: z.number().optional(),
  dailySeries: z.array(dashboardDailyPointSchema).optional(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const auditLogItemSchema = z.object({
  id: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  actorLabel: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  createdAt: z.string(),
});
export type AuditLogItem = z.infer<typeof auditLogItemSchema>;

export const notificationsSummarySchema = z.object({
  unreadCount: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      readAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type NotificationsSummary = z.infer<typeof notificationsSummarySchema>;
