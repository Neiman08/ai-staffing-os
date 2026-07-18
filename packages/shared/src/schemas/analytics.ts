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

/**
 * F11.4: funnel real de reclutamiento -- cada etapa es un conteo de
 * CANDIDATOS DISTINTOS (nunca de filas, ej. un candidato calificado para
 * 3 Job Orders cuenta una sola vez en "qualified"), calculado sobre
 * datos ya persistidos por F8 (CandidateQualification/
 * CandidateShortlistEntry) y F9.4 (Placement) -- cero campo inventado,
 * cero predicción. `period` es el rango real (from/to) sobre el que se
 * filtró `Candidate.createdAt` para "sourced" y las fechas de cada etapa
 * subsecuente.
 */
export const recruitingFunnelSchema = z.object({
  sourced: z.number(),
  qualified: z.number(),
  shortlisted: z.number(),
  placed: z.number(),
});
export type RecruitingFunnel = z.infer<typeof recruitingFunnelSchema>;

export const timeToFillSchema = z.object({
  // Promedio real en días entre JobOrder.createdAt y el Placement no-DRAFT/
  // no-CANCELLED más antiguo de ese Job Order -- null cuando no hay ningún
  // Job Order con un Placement real en el período (nunca se inventa un 0).
  averageDays: z.number().nullable(),
  jobOrdersFilled: z.number(),
});
export type TimeToFill = z.infer<typeof timeToFillSchema>;

export const sourceEffectivenessEntrySchema = z.object({
  source: z.string(),
  candidateCount: z.number(),
  placedCount: z.number(),
  placementRate: z.number(),
});
export type SourceEffectivenessEntry = z.infer<typeof sourceEffectivenessEntrySchema>;

const recruitingMetricsBlockSchema = z.object({
  period: resolvedPeriodSchema.optional(),
  funnel: recruitingFunnelSchema.optional(),
  timeToFill: timeToFillSchema.optional(),
  sourceEffectiveness: z.array(sourceEffectivenessEntrySchema).optional(),
});

export const recruitingMetricsSchema = z.object({
  generatedAt: z.string(),
  recruiting: recruitingMetricsBlockSchema,
});
export type RecruitingMetrics = z.infer<typeof recruitingMetricsSchema>;

/**
 * F11.5: winRate/salesCycle sobre Opportunity.stage real (WON/LOST,
 * OpportunityStage ya existente) -- ninguna etapa nueva inventada.
 * salesCycleDays usa Opportunity.updatedAt como proxy de "cuándo se
 * ganó" (no existe un campo closedAt dedicado en el schema) --
 * documentado como proxy, no como una medición exacta de la fecha de
 * cierre real si el registro se editó por otro motivo después de
 * ganarse.
 */
export const winRateSchema = z.object({
  won: z.number(),
  lost: z.number(),
  winRatePercent: z.number().nullable(),
});
export type WinRate = z.infer<typeof winRateSchema>;

export const salesCycleSchema = z.object({
  averageDays: z.number().nullable(),
  opportunitiesWon: z.number(),
});
export type SalesCycle = z.infer<typeof salesCycleSchema>;

/**
 * F11.5: proxy a nivel de EMPRESA (companyId), no de Lead individual --
 * Opportunity no tiene un leadId real en el schema, así que un
 * conversionRate lead-a-lead no puede calcularse sin inventar un vínculo
 * que no existe en los datos. leadToOpportunityRate mide, en cambio, qué
 * proporción de las companies con un Lead nuevo en el período también
 * tienen alguna Opportunity real (cualquier etapa, cualquier fecha) --
 * un proxy honesto, grounded en el FK companyId real de ambos modelos.
 */
export const conversionMetricsSchema = z.object({
  leadConversionRate: z.number().nullable(),
  // Opcional (no solo nullable): ausente por completo cuando el caller
  // tiene leads.view pero no opportunities.view (sin permiso, distinto
  // de "hay datos mide 0/null") -- null cuando sí tiene ambos permisos
  // pero no hay compañías con Lead en el período (sin datos que medir).
  leadToOpportunityRate: z.number().nullable().optional(),
});
export type ConversionMetrics = z.infer<typeof conversionMetricsSchema>;

const commercialMetricsBlockSchema = z.object({
  period: resolvedPeriodSchema.optional(),
  winRate: winRateSchema.optional(),
  salesCycle: salesCycleSchema.optional(),
  conversion: conversionMetricsSchema.optional(),
});

export const commercialMetricsSchema = z.object({
  generatedAt: z.string(),
  commercial: commercialMetricsBlockSchema,
});
export type CommercialMetrics = z.infer<typeof commercialMetricsSchema>;

/**
 * F11.6: margen real día por día -- misma fórmula que
 * dashboard/service.ts ya usa para su serie de 14 días (regularHours +
 * overtimeHours + doubleHours, margen = horas * (billRate - payRate)
 * snapshot de la Assignment), generalizada a cualquier rango en vez de
 * quedar hardcodeada a 14 días.
 */
export const marginTrendPointSchema = z.object({ date: z.string(), hours: z.number(), margin: z.number() });
export type MarginTrendPoint = z.infer<typeof marginTrendPointSchema>;

/**
 * F11.6: antigüedad real de facturas impagas -- balance = total -
 * sum(Payment.amount), mismo cálculo ya usado por
 * billing/scheduler.ts:flagOverdueInvoicesForTenant (F5.8), nunca una
 * columna paidAmount que pueda desincronizarse. Los buckets son días
 * reales desde dueDate hasta hoy -- una factura sin dueDate no entra en
 * ningún bucket (no se inventa una fecha de vencimiento).
 */
export const invoiceAgingSchema = z.object({
  current: z.string(), // 0-30 días
  days31to60: z.string(),
  days61to90: z.string(),
  over90: z.string(),
  totalOutstanding: z.string(),
});
export type InvoiceAging = z.infer<typeof invoiceAgingSchema>;

export const payrollCostSchema = z.object({
  totalGross: z.string(),
  totalBill: z.string(),
  totalMargin: z.string(),
  runsIncluded: z.number(),
});
export type PayrollCost = z.infer<typeof payrollCostSchema>;

const financialMetricsBlockSchema = z.object({
  period: resolvedPeriodSchema.optional(),
  marginTrend: z.array(marginTrendPointSchema).optional(),
  invoiceAging: invoiceAgingSchema.optional(),
  payrollCost: payrollCostSchema.optional(),
});

export const financialMetricsSchema = z.object({
  generatedAt: z.string(),
  financial: financialMetricsBlockSchema,
});
export type FinancialMetrics = z.infer<typeof financialMetricsSchema>;
