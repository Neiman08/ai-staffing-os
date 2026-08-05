/**
 * F34 (auditoría arquitectónica transversal, hallazgo real: 71.9% de
 * discovery duplicado, 48.4% de queries con cero empresas nuevas sobre
 * 10 misiones de producción, 2026-08-05): scoring puro y determinista de
 * "saturación" de una query de discovery -- nunca toca Prisma/fetch,
 * mismo criterio que el resto de ceo-intelligence/. La persistencia real
 * (leer/escribir DiscoveryQueryExecution) vive en
 * agents/query-saturation-memory.ts -- este módulo solo sabe convertir
 * una lista de ejecuciones recientes (ya filtradas por tenant/query/
 * estado/ventana TTL por el llamador) en un veredicto accionable.
 */

export const querySaturationLevels = ["FRESH", "DECLINING", "SATURATED"] as const;
export type QuerySaturationLevel = (typeof querySaturationLevels)[number];

export interface QuerySaturationSample {
  rawResultCount: number;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  executedAt: string; // ISO -- se asume ORDEN DESCENDENTE (más reciente primero) en `samples`
}

export interface QuerySaturationInput {
  samples: QuerySaturationSample[];
}

export interface QuerySaturationResult {
  level: QuerySaturationLevel;
  // null cuando no hay suficiente historial (samples vacío o rawResultCount total = 0) -- nunca se inventa un ratio.
  noveltyRatio: number | null;
  totalRawResults: number;
  totalAccepted: number;
  totalDuplicates: number;
  executionsConsidered: number;
  // Cantidad de ejecuciones MÁS RECIENTES consecutivas con acceptedCount=0 -- 0 si la última tuvo al menos 1 aceptado.
  consecutiveZeroNewRuns: number;
  reason: string;
  shouldSkip: boolean;
  shouldDeprioritize: boolean;
}

// Umbral mínimo de volumen antes de confiar en un ratio de novedad --
// una sola query con 2 resultados y 0 aceptados no es evidencia real de
// saturación (podría ser una zona genuinamente chica), 10+ resultados
// crudos acumulados sí lo son.
const MIN_RAW_RESULTS_FOR_RATIO = 10;
// >90% duplicados (ratio de novedad <10%) -- mismo umbral que pidió
// explícitamente la auditoría ("si una query reciente devolvió más de
// 90% de duplicados").
const SATURATED_NOVELTY_RATIO = 0.1;
const DECLINING_NOVELTY_RATIO = 0.3;
// "cero empresas nuevas en varias ejecuciones" -- 2 ejecuciones
// consecutivas (las más recientes) con acceptedCount=0 ya cuenta,
// independiente del volumen crudo de cada una.
const SATURATED_CONSECUTIVE_ZERO_RUNS = 2;

/**
 * Evalúa el nivel de saturación de una query real a partir de su
 * historial reciente (ya acotado por el llamador a la ventana TTL y al
 * tenant/query/estado/trade correctos). Puro y determinista -- mismo
 * input siempre produce el mismo resultado.
 */
export function evaluateQuerySaturation(input: QuerySaturationInput): QuerySaturationResult {
  const samples = input.samples;
  if (samples.length === 0) {
    return {
      level: "FRESH",
      noveltyRatio: null,
      totalRawResults: 0,
      totalAccepted: 0,
      totalDuplicates: 0,
      executionsConsidered: 0,
      consecutiveZeroNewRuns: 0,
      reason: "Sin historial reciente para esta query -- se considera nueva.",
      shouldSkip: false,
      shouldDeprioritize: false,
    };
  }

  const totalRawResults = samples.reduce((sum, s) => sum + s.rawResultCount, 0);
  const totalAccepted = samples.reduce((sum, s) => sum + s.acceptedCount, 0);
  const totalDuplicates = samples.reduce((sum, s) => sum + s.duplicateCount, 0);

  let consecutiveZeroNewRuns = 0;
  for (const sample of samples) {
    if (sample.acceptedCount === 0) consecutiveZeroNewRuns += 1;
    else break;
  }

  const noveltyRatio = totalRawResults > 0 ? totalAccepted / totalRawResults : null;

  const hasReliableRatio = noveltyRatio !== null && totalRawResults >= MIN_RAW_RESULTS_FOR_RATIO;
  const saturatedByRatio = hasReliableRatio && (noveltyRatio as number) < SATURATED_NOVELTY_RATIO;
  const saturatedByZeroRuns = consecutiveZeroNewRuns >= SATURATED_CONSECUTIVE_ZERO_RUNS;

  if (saturatedByRatio || saturatedByZeroRuns) {
    const reasonParts: string[] = [];
    if (saturatedByRatio) {
      reasonParts.push(
        `ratio de novedad ${((noveltyRatio as number) * 100).toFixed(1)}% (<${(SATURATED_NOVELTY_RATIO * 100).toFixed(0)}%) sobre ${totalRawResults} resultados crudos acumulados`,
      );
    }
    if (saturatedByZeroRuns) {
      reasonParts.push(`${consecutiveZeroNewRuns} ejecuciones recientes consecutivas sin ninguna empresa nueva`);
    }
    return {
      level: "SATURATED",
      noveltyRatio,
      totalRawResults,
      totalAccepted,
      totalDuplicates,
      executionsConsidered: samples.length,
      consecutiveZeroNewRuns,
      reason: `Query saturada: ${reasonParts.join("; ")}.`,
      shouldSkip: true,
      shouldDeprioritize: true,
    };
  }

  if (hasReliableRatio && (noveltyRatio as number) < DECLINING_NOVELTY_RATIO) {
    return {
      level: "DECLINING",
      noveltyRatio,
      totalRawResults,
      totalAccepted,
      totalDuplicates,
      executionsConsidered: samples.length,
      consecutiveZeroNewRuns,
      reason: `Rendimiento decreciente: ratio de novedad ${((noveltyRatio as number) * 100).toFixed(1)}% sobre ${totalRawResults} resultados crudos acumulados -- no se omite, pero se prioriza diversificar (otra ciudad/subcategoría/fuente).`,
      shouldSkip: false,
      shouldDeprioritize: true,
    };
  }

  return {
    level: "FRESH",
    noveltyRatio,
    totalRawResults,
    totalAccepted,
    totalDuplicates,
    executionsConsidered: samples.length,
    consecutiveZeroNewRuns,
    reason: hasReliableRatio
      ? `Ratio de novedad saludable (${((noveltyRatio as number) * 100).toFixed(1)}%).`
      : "Historial insuficiente para un ratio confiable -- se trata como query fresca.",
    shouldSkip: false,
    shouldDeprioritize: false,
  };
}
