/**
 * Corrección estructural (misión Iowa, 2026-07-13): People Data Labs
 * respondió HTTP 402 ("account maximum for search — all matches used")
 * para las 25 empresas de la misión, una por una, cada una tratada como
 * un fallo aislado de esa empresa puntual — nunca se distinguió
 * "no hay créditos, no vale la pena seguir preguntando" de "esta empresa
 * puntual no tiene datos". Este módulo es ese distingo, compartido por
 * cualquier proveedor externo (People Data Labs, Hunter.io, y cualquiera
 * que se agregue después).
 *
 * TTL corto (no permanente): un 402 real puede resolverse dentro del
 * mismo día (el PO recarga créditos) — cachear "para siempre" ocultaría
 * eso. El TTL solo evita repetir la misma llamada condenada 25 veces en
 * una sola misión.
 */
export type ProviderHealthStatus = "AVAILABLE" | "CREDIT_EXHAUSTED" | "UNAUTHORIZED" | "UNAVAILABLE";

interface ProviderHealthEntry {
  status: ProviderHealthStatus;
  reason: string;
  markedAt: number;
}

const HEALTH_TTL_MS = 15 * 60 * 1000; // 15 minutos
const registry = new Map<string, ProviderHealthEntry>();

/** Clasifica una respuesta HTTP real de un proveedor — nunca adivina, solo mapea códigos ya observados. */
export function classifyProviderHttpStatus(status: number): ProviderHealthStatus {
  if (status === 402) return "CREDIT_EXHAUSTED";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 429 || status >= 500) return "UNAVAILABLE";
  return "AVAILABLE";
}

/** Marca un proveedor como no disponible por un motivo real (respuesta HTTP real, nunca inventado). */
export function markProviderStatus(providerKey: string, status: ProviderHealthStatus, reason: string): void {
  if (status === "AVAILABLE") {
    registry.delete(providerKey);
    return;
  }
  registry.set(providerKey, { status, reason, markedAt: Date.now() });
}

/**
 * Devuelve el estado marcado si sigue vigente (dentro del TTL), o null si
 * nunca se marcó o ya expiró — en cuyo caso el llamador debe intentar la
 * llamada real de nuevo, no asumir que sigue exhausto.
 */
export function getProviderHealth(providerKey: string): ProviderHealthEntry | null {
  const entry = registry.get(providerKey);
  if (!entry) return null;
  if (Date.now() - entry.markedAt > HEALTH_TTL_MS) {
    registry.delete(providerKey);
    return null;
  }
  return entry;
}

/** Solo para tests — evita que el estado de un test se filtre al siguiente. */
export function resetProviderHealthForTests(): void {
  registry.clear();
}
