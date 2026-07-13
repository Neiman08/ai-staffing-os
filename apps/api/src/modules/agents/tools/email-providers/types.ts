import type { ProviderHealthStatus } from "../provider-health";

/**
 * F4.7 §2: contrato compartido entre proveedores de email discovery
 * (Website Intelligence hoy — gratis — y Hunter.io como proveedor
 * pago; Apollo/Clearbit/etc. son intercambiables detrás del mismo
 * contrato). El Contact Intelligence Agent
 * (../contact-intelligence-tools.impl.ts) hace matching/verificación/
 * creación de Contact una sola vez sobre este shape común, sin importar
 * de qué fuente vino cada candidato — el agente nunca sabe cuál está
 * detrás. Mismo patrón exacto que discovery-providers/types.ts y
 * contact-providers/types.ts.
 */
export interface EmailCandidate {
  // null = el candidato es un email genérico de la empresa (ej.
  // info@empresa.com), sin una persona específica asociada — nunca se
  // fuerza un nombre que la fuente no trajo.
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string; // siempre presente — un candidato sin email no es un candidato
  confidenceScore: number | null; // 0–1, si la fuente lo provee
  sourceUrl: string | null;
}

export interface EmailProviderSearchResult {
  candidates: EmailCandidate[];
  costUsd: number; // 0 si la fuente no cobra (Website Intelligence) o si no se llegó a pegar
  sourcesUsed: string[];
  patternsFailed: string[];
  cancelled: boolean;
  // Corrección estructural: distingue "sin resultado para este dominio"
  // de "la cuenta del proveedor no puede responder nada ahora" — ver
  // ../provider-health.ts.
  providerStatus: ProviderHealthStatus;
}

export interface EmailProviderSearchParams {
  taskId: string;
  companyName: string;
  companyWebsite: string | null;
  domain: string | null; // dominio derivado de companyWebsite, sin protocolo (ej. "empresa.com")
  limit: number;
  abortSignal?: AbortSignal;
}

export function emptyEmailResult(): EmailProviderSearchResult {
  return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [], cancelled: false, providerStatus: "AVAILABLE" };
}
