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
