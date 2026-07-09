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

export const dashboardSummarySchema = z.object({
  activeWorkers: z.number(),
  candidatesByStatus: z.record(z.string(), z.number()),
  openJobOrders: z.number(),
  fillRate: z.number(),
  unresolvedComplianceAlerts: z.number(),
  weeklyHours: z.number(),
  weeklyGrossMargin: z.number(),
  billableRevenuePeriod: z.number(),
  dailySeries: z.array(dashboardDailyPointSchema),
  recentAlerts: z.array(dashboardAlertSchema),
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
