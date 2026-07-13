import type { EmailCandidate, EmailProviderSearchParams, EmailProviderSearchResult } from "./types";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "../provider-health";

const PROVIDER_KEY = "hunter_domain_search";

/**
 * F4.7 §2.3: Hunter.io Domain Search — proveedor #2 de email discovery
 * (solo se consulta si Website Intelligence no encontró nada, ver
 * ../contact-intelligence-tools.impl.ts). Aprobado por el Product Owner
 * para arrancar en el free tier (25 búsquedas/mes, sin tarjeta) — F4.7
 * Bloqueante B1. Requiere HUNTER_API_KEY; si no está configurada, el
 * orquestador ni siquiera llama a este módulo.
 *
 * Docs: https://hunter.io/api-documentation/v2#domain-search
 */
const HUNTER_DOMAIN_SEARCH_ENDPOINT = "https://api.hunter.io/v2/domain-search";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];

// Hunter cobra por plan mensual (cantidad de búsquedas incluidas), no por
// registro devuelto como People Data Labs — mientras se use el free tier
// aprobado (B1), el costo real de cada búsqueda es $0. Si se contrata un
// plan pago, este valor debe actualizarse con el costo real por búsqueda
// (a calcular contra el plan vigente, mismo criterio que COST_PER_MATCH_USD
// de people-data-labs.ts) — NUNCA una estimación inventada.
const COST_PER_SEARCH_USD = 0;

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[email:hunter-discovery] ${event}`, JSON.stringify({ taskId, ...data }));
}

function isCancellation(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

interface HunterEmailRecord {
  value?: unknown;
  confidence?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  position?: unknown;
  sources?: unknown;
}

function isRealString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractSourceUrl(sources: unknown): string | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const first = sources[0] as { uri?: unknown } | undefined;
  return isRealString(first?.uri) ? first.uri : null;
}

async function fetchHunterDomainSearch(
  taskId: string,
  apiKey: string,
  domain: string,
  limit: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ emails: HunterEmailRecord[] } | { error: string; cancelled?: boolean; httpStatus?: number }> {
  const url = new URL(HUNTER_DOMAIN_SEARCH_ENDPOINT);
  url.searchParams.set("domain", domain);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("limit", String(limit));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(abortSignal)) {
      log(taskId, "provider request cancelled", { domain, attempt });
      return { error: "cancelled by user", cancelled: true };
    }

    log(taskId, "provider requested", { provider: "Hunter.io (domain search)", domain, attempt, maxAttempts: MAX_RETRIES });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(url, { method: "GET", signal });
      log(taskId, "provider response", { domain, attempt, status: res.status, ok: res.ok });

      if (res.status === 404) return { emails: [] };
      if (!res.ok) {
        if (res.status < 500 && res.status !== 429) {
          const body = await res.text().catch(() => "");
          return { error: `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`, httpStatus: res.status };
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return { error: `HTTP ${res.status}`, httpStatus: res.status };
      }
      const json = (await res.json()) as { data?: { emails?: HunterEmailRecord[] } };
      return { emails: json.data?.emails ?? [] };
    } catch (err) {
      if (abortSignal?.aborted) {
        log(taskId, "provider request cancelled mid-flight", { domain, attempt });
        return { error: "cancelled by user", cancelled: true };
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "provider response", { domain, attempt, error: errorLabel });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
}

export async function searchHunterEmails(params: EmailProviderSearchParams, apiKey: string): Promise<EmailProviderSearchResult> {
  if (!params.domain) {
    return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [`${params.companyName}:sin dominio derivable de companyWebsite`], cancelled: false, providerStatus: "AVAILABLE" };
  }

  const existingHealth = getProviderHealth(PROVIDER_KEY);
  if (existingHealth && existingHealth.status !== "AVAILABLE") {
    return {
      candidates: [],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: [`Hunter.io: ${existingHealth.status} — ${existingHealth.reason} (no se reintenta por ~15 min)`],
      cancelled: false,
      providerStatus: existingHealth.status,
    };
  }

  const result = await fetchHunterDomainSearch(params.taskId, apiKey, params.domain, params.limit, params.abortSignal);

  if ("error" in result) {
    const providerStatus = result.httpStatus != null ? classifyProviderHttpStatus(result.httpStatus) : "AVAILABLE";
    if (providerStatus !== "AVAILABLE") markProviderStatus(PROVIDER_KEY, providerStatus, result.error);
    return {
      candidates: [],
      costUsd: 0, // error real de la API — no se cobra un request fallido
      sourcesUsed: [],
      patternsFailed: [`${params.domain}:hunter_domain_search (${result.error})`],
      cancelled: !!result.cancelled,
      providerStatus,
    };
  }

  log(params.taskId, "records found", { provider: "Hunter.io (domain search)", domain: params.domain, count: result.emails.length });

  const candidates: EmailCandidate[] = result.emails
    .filter((e) => isRealString(e.value))
    .map((e) => ({
      firstName: isRealString(e.first_name) ? e.first_name : null,
      lastName: isRealString(e.last_name) ? e.last_name : null,
      title: isRealString(e.position) ? e.position : null,
      email: e.value as string,
      confidenceScore: typeof e.confidence === "number" ? Math.min(1, Math.max(0, e.confidence / 100)) : null,
      sourceUrl: extractSourceUrl(e.sources),
    }));

  return {
    candidates,
    costUsd: candidates.length > 0 ? COST_PER_SEARCH_USD : 0,
    sourcesUsed: candidates.length > 0 ? [`Hunter.io (${params.domain})`] : [],
    patternsFailed: [],
    cancelled: false,
    providerStatus: "AVAILABLE",
  };
}
