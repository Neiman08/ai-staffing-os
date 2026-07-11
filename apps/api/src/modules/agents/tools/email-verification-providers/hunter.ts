import type { EmailVerificationParams, EmailVerificationResult } from "./types";
import { unknownVerificationResult } from "./types";

/**
 * F4.7 §3.2: Hunter.io Email Verifier — mismo vendor que
 * email-providers/hunter.ts (una sola credencial nueva, aprobado por el
 * Product Owner, F4.7 Bloqueante B2). Requiere HUNTER_API_KEY.
 *
 * Docs: https://hunter.io/api-documentation/v2#email-verifier
 */
const HUNTER_VERIFIER_ENDPOINT = "https://api.hunter.io/v2/email-verifier";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];

// Mismo criterio que hunter.ts de discovery: mientras se use el free
// tier (50 verificaciones/mes), el costo real es $0 — actualizar si se
// contrata un plan pago, nunca una estimación inventada.
const COST_PER_VERIFICATION_USD = 0;

const PROVIDER_NAME = "Hunter.io";

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[email:hunter-verify] ${event}`, JSON.stringify({ taskId, ...data }));
}

interface HunterVerifierData {
  // F4.7: `result` (deliverable/risky/undeliverable) está marcado
  // "deprecated, use status instead" por la propia API (confirmado en
  // una llamada real) — se usa `status`, el campo vigente.
  status?: unknown; // "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown"
  score?: unknown; // 0-100
}

export function mapStatusToVerificationStatus(status: unknown): EmailVerificationResult["status"] {
  if (status === "valid") return "VERIFIED";
  if (status === "invalid" || status === "disposable") return "INVALID";
  if (status === "accept_all" || status === "webmail") return "RISKY";
  return "UNKNOWN";
}

export async function verifyEmailWithHunter(params: EmailVerificationParams, apiKey: string): Promise<EmailVerificationResult> {
  const url = new URL(HUNTER_VERIFIER_ENDPOINT);
  url.searchParams.set("email", params.email);
  url.searchParams.set("api_key", apiKey);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (params.abortSignal?.aborted) {
      log(params.taskId, "provider request cancelled", { attempt });
      return { ...unknownVerificationResult(PROVIDER_NAME, "cancelled by user"), cancelled: true };
    }

    log(params.taskId, "provider requested", { provider: PROVIDER_NAME, attempt, maxAttempts: MAX_RETRIES });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = params.abortSignal ? AbortSignal.any([timeoutSignal, params.abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(url, { method: "GET", signal });
      log(params.taskId, "provider response", { attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        if (res.status < 500 && res.status !== 429) {
          const body = await res.text().catch(() => "");
          return unknownVerificationResult(PROVIDER_NAME, `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return unknownVerificationResult(PROVIDER_NAME, `HTTP ${res.status}`);
      }

      const json = (await res.json()) as { data?: HunterVerifierData };
      const status = mapStatusToVerificationStatus(json.data?.status);
      const score = typeof json.data?.score === "number" ? Math.min(1, Math.max(0, json.data.score / 100)) : null;

      return {
        status,
        confidenceScore: score,
        provider: PROVIDER_NAME,
        costUsd: COST_PER_VERIFICATION_USD,
        cancelled: false,
        error: null,
      };
    } catch (err) {
      if (params.abortSignal?.aborted) {
        log(params.taskId, "provider request cancelled mid-flight", { attempt });
        return { ...unknownVerificationResult(PROVIDER_NAME, "cancelled by user"), cancelled: true };
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(params.taskId, "provider response", { attempt, error: errorLabel });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return unknownVerificationResult(PROVIDER_NAME, errorLabel);
    }
  }
  return unknownVerificationResult(PROVIDER_NAME, "exhausted retries");
}
