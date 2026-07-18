import { z } from "zod";

// F11.2: filtro de rango de fechas compartido por los 4 endpoints de
// analítica (executive/recruiting/commercial/financial). `from`/`to` son
// opcionales -- cada servicio define su propio rango por defecto (ver
// apps/api/src/core/analytics/period.ts), nunca un default duplicado acá.
// z.coerce.date() acepta "YYYY-MM-DD" y datetime ISO completo por igual.
export const analyticsPeriodQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AnalyticsPeriodQuery = z.infer<typeof analyticsPeriodQuerySchema>;

// F11.7: comparación de período contra período -- siempre dos conteos
// reales, nunca una proyección. deltaPercent es null cuando previous=0 y
// current=0 no aplica (sin base para calcular un porcentaje real, en vez
// de inventar un 0% o un Infinity).
export const periodComparisonSchema = z.object({
  current: z.number(),
  previous: z.number(),
  deltaPercent: z.number().nullable(),
});
export type PeriodComparison = z.infer<typeof periodComparisonSchema>;

export const resolvedPeriodSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type ResolvedPeriod = z.infer<typeof resolvedPeriodSchema>;

/**
 * F11.3: cada CAMPO es independientemente opcional -- mismo criterio F6.8
 * ya usado por dashboard/service.ts y reports/service.ts, aplicado dentro
 * de cada bloque en vez de al bloque completo. Un caller con
 * workers.view pero sin jobOrders.view ve activeWorkers sin ver
 * openJobOrders/fillRate -- nunca se le niega todo el bloque "recruiting"
 * por faltarle un solo permiso de los varios que lo alimentan. Nunca un
 * campo en 0 para un caller sin el permiso real -- se omite el campo
 * entero, distinto de "hay cero datos".
 */
const recruitingBlockSchema = z.object({
  activeWorkers: z.number().optional(),
  openJobOrders: z.number().optional(),
  fillRate: z.number().optional(),
  candidatesByStatus: z.record(z.string(), z.number()).optional(),
});

const commercialBlockSchema = z.object({
  newLeadsThisWeek: z.number().optional(),
  openOpportunities: z.number().optional(),
  pipelineValue: z.string().optional(),
  scheduledMeetings: z.number().optional(),
});

const operationsBlockSchema = z.object({
  assignmentsByStatus: z.record(z.string(), z.number()).optional(),
  unresolvedComplianceAlerts: z.number().optional(),
  openIncidentCount: z.number().optional(),
});

const financialBlockSchema = z.object({
  weeklyHours: z.number().optional(),
  weeklyGrossMargin: z.number().optional(),
  billableRevenuePeriod: z.number().optional(),
  dailySeries: z.array(z.object({ date: z.string(), hours: z.number(), margin: z.number() })).optional(),
});

export const executiveDashboardSchema = z.object({
  generatedAt: z.string(),
  recruiting: recruitingBlockSchema,
  commercial: commercialBlockSchema,
  operations: operationsBlockSchema,
  financial: financialBlockSchema,
});
export type ExecutiveDashboard = z.infer<typeof executiveDashboardSchema>;
