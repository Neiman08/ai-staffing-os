import type { AnalyticsPeriodQuery, PeriodComparison, ResolvedPeriod } from "@ai-staffing-os/shared";

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * F11.2: un único punto donde se decide el rango de fechas de un
 * endpoint de analítica -- nunca un `daysAgo(N)` hardcodeado repetido en
 * cada service (ese era el patrón de dashboard/service.ts y
 * revenue/service.ts antes de F11, cada uno con su propia ventana fija).
 * `from`/`to` ya vienen validados y coeridos a Date por
 * analyticsPeriodQuerySchema (packages/shared/src/schemas/analytics.ts)
 * -- este helper solo aplica el default cuando el caller no filtró.
 */
export function resolvePeriod(query: AnalyticsPeriodQuery, defaultDays: number): DateRange {
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * F11.7: el período inmediatamente anterior, de la misma duración exacta
 * que el período actual -- así "esta semana vs. semana pasada" y "este
 * mes vs. mes pasado" (con from/to explícitos de distinta duración)
 * comparan contra una ventana real equivalente, nunca una ventana fija
 * de 7/30 días sin relación con el rango que el caller pidió.
 */
export function previousPeriod(range: DateRange): DateRange {
  const durationMs = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - durationMs), to: new Date(range.from.getTime()) };
}

/**
 * null cuando previous=0 y current!=0: un delta porcentual desde una base
 * de cero no es un número real (sería +Infinity%) -- nunca se inventa un
 * valor ahí. previous=0 y current=0 sí es un 0% real y determinista.
 */
export function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

export function comparePeriods(current: number, previous: number): PeriodComparison {
  return { current, previous, deltaPercent: percentDelta(current, previous) };
}

export function toResolvedPeriod(range: DateRange): ResolvedPeriod {
  return { from: range.from.toISOString(), to: range.to.toISOString() };
}
