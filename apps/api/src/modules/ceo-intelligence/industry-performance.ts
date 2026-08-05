/**
 * F34 (auditoría arquitectónica transversal, 2026-08-05): "sin cambiar
 * reglas comerciales sin autorización, implementa soporte para priorizar
 * industrias SEGÚN DATOS REALES... configura la validación para
 * DEMOSTRAR, no ASUMIR, el rendimiento" -- este módulo nunca decide por
 * su cuenta qué industria priorizar/descartar (eso sigue siendo una
 * decisión de producto, fuera de este alcance) -- solo agrega los
 * conteos reales YA calculados (commercial-metrics.ts) por industria y
 * los ordena por la métrica que el llamador elija, de forma
 * transparente y auditable. Puro y determinista, sin Prisma/fetch/LLM.
 */

import { aggregateCommercialMetrics, type CommercialMetricsInput, type CommercialMetricsResult } from "./commercial-metrics";

export interface IndustryMissionSample {
  industryName: string;
  missionId: string;
  metrics: CommercialMetricsInput;
}

export interface IndustryPerformanceEntry {
  industryName: string;
  missionCount: number;
  metrics: CommercialMetricsResult;
}

// Métricas donde un valor MÁS BAJO es mejor (costo) vs. MÁS ALTO es mejor
// (tasa de conversión) -- necesario para ordenar de forma honesta: nunca
// se asume que "más alto siempre es mejor".
const LOWER_IS_BETTER: ReadonlySet<keyof CommercialMetricsResult> = new Set([
  "duplicateRate",
  "hardBounceRate",
  "spamBlockedRate",
  "costPerValidatedCompany",
  "costPerLead",
  "costPerOpportunity",
  "costPerReply",
  "costPerMeeting",
]);

/**
 * Agrupa muestras reales de misiones por industria, agrega sus conteos
 * (aggregateCommercialMetrics -- suma antes de calcular ratios, nunca
 * promedia ratios ya calculados) y ordena el resultado por la métrica
 * pedida. Industrias sin dato real para esa métrica (null) SIEMPRE
 * quedan al final, sin importar la dirección del orden -- nunca se
 * asume que "sin dato" es mejor o peor que un valor real.
 */
export function rankIndustriesByPerformance(samples: IndustryMissionSample[], sortBy: keyof CommercialMetricsResult): IndustryPerformanceEntry[] {
  const byIndustry = new Map<string, CommercialMetricsInput[]>();
  for (const sample of samples) {
    const existing = byIndustry.get(sample.industryName) ?? [];
    existing.push(sample.metrics);
    byIndustry.set(sample.industryName, existing);
  }

  const entries: IndustryPerformanceEntry[] = Array.from(byIndustry.entries()).map(([industryName, missions]) => ({
    industryName,
    missionCount: missions.length,
    metrics: aggregateCommercialMetrics(missions),
  }));

  const lowerIsBetter = LOWER_IS_BETTER.has(sortBy);

  return entries.slice().sort((a, b) => {
    const valueA = a.metrics[sortBy];
    const valueB = b.metrics[sortBy];
    if (valueA === null && valueB === null) return 0;
    if (valueA === null) return 1; // sin dato siempre al final
    if (valueB === null) return -1;
    const diff = (valueA as number) - (valueB as number);
    return lowerIsBetter ? diff : -diff;
  });
}
