/**
 * F25 Fase 1: clasificación de error -- docs/F25_AUTONOMOUS_ORGANIZATION_MASTER_ARCHITECTURE.md
 * §13. Solo los 4 `RETRYABLE_*` programan un reintento automático
 * (`nextAttemptAt` con backoff+jitter, ver `computeBackoff` más abajo).
 * `maxAttempts` agotado siempre termina en FAILED_FINAL, nunca
 * reintento infinito (principio #13).
 */
export const AGENT_ERROR_CATEGORIES = [
  "RETRYABLE_NETWORK",
  "RETRYABLE_PROVIDER",
  "RETRYABLE_RATE_LIMIT",
  "RETRYABLE_TIMEOUT",
  "INVALID_INPUT",
  "POLICY_BLOCKED",
  "DATA_INSUFFICIENT",
  "PERMANENT_PROVIDER_ERROR",
  "HUMAN_ACTION_REQUIRED",
  "UNKNOWN",
] as const;

export type AgentErrorCategory = (typeof AGENT_ERROR_CATEGORIES)[number];

const RETRYABLE_CATEGORIES: ReadonlySet<AgentErrorCategory> = new Set([
  "RETRYABLE_NETWORK",
  "RETRYABLE_PROVIDER",
  "RETRYABLE_RATE_LIMIT",
  "RETRYABLE_TIMEOUT",
]);

export function isRetryableCategory(category: AgentErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

export class AgentError extends Error {
  readonly category: AgentErrorCategory;
  readonly cause?: unknown;

  constructor(category: AgentErrorCategory, message: string, cause?: unknown) {
    super(message);
    this.name = "AgentError";
    this.category = category;
    this.cause = cause;
  }
}

/**
 * Backoff exponencial con jitter -- docs §13: `base * 2^attempt +
 * random(0, jitter)`, con tope máximo. Determinista salvo por el
 * jitter (que es, a propósito, la única fuente de aleatoriedad: evita
 * que reintentos de tareas fallidas en simultáneo golpeen el mismo
 * proveedor externo exactamente al mismo tiempo -- "thundering herd").
 */
export function computeBackoffMs(params: { attempt: number; baseMs?: number; maxMs?: number; jitterMs?: number }): number {
  const baseMs = params.baseMs ?? 1000;
  const maxMs = params.maxMs ?? 5 * 60 * 1000; // 5 min
  const jitterMs = params.jitterMs ?? 1000;
  const exponential = baseMs * 2 ** Math.max(0, params.attempt);
  const withJitter = exponential + Math.random() * jitterMs;
  return Math.min(withJitter, maxMs);
}

/**
 * Clasificación pura de un error crudo (Error/unknown) en una
 * categoría del catálogo -- usada por el futuro Orchestrator (F25.2/
 * F25.5) para decidir reintento vs. terminal sin acoplarse a la forma
 * exacta de cada proveedor externo. Heurística conservadora: ante
 * duda, UNKNOWN (nunca asume retryable sin evidencia -- reintentar
 * algo no-retryable indefinidamente sería peor que fallar rápido).
 */
export function classifyError(error: unknown): AgentErrorCategory {
  if (error instanceof AgentError) return error.category;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("econnreset") || message.includes("econnrefused") || message.includes("enotfound") || message.includes("network")) {
    return "RETRYABLE_NETWORK";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("etimedout")) {
    return "RETRYABLE_TIMEOUT";
  }
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "RETRYABLE_RATE_LIMIT";
  }
  if (message.includes("502") || message.includes("503") || message.includes("504") || message.includes("bad gateway") || message.includes("service unavailable")) {
    return "RETRYABLE_PROVIDER";
  }
  if (message.includes("401") || message.includes("403") || message.includes("unauthorized") || message.includes("forbidden")) {
    return "PERMANENT_PROVIDER_ERROR";
  }
  if (message.includes("presupuesto") || message.includes("budget")) {
    return "POLICY_BLOCKED";
  }
  return "UNKNOWN";
}
