import type { DiscoveredField } from "@ai-staffing-os/agents";
import type { ProviderHealthStatus } from "../provider-health";

/**
 * F4.6: contrato compartido entre proveedores de contactos (People Data
 * Labs hoy; Apollo/Proxycurl/Clay son intercambiables detrás del mismo
 * contrato — ver README.md en este directorio). El Contact Intelligence
 * Agent (contact-intelligence-tools.impl.ts) hace dedup/scoring/creación
 * de Contact una sola vez sobre este shape común, sin importar de qué
 * proveedor vino cada candidato — el agente nunca sabe qué proveedor está
 * detrás. Mismo patrón exacto que discovery-providers/types.ts.
 */
export interface ContactCandidate {
  // null = el proveedor devolvió el registro pero sin nombre utilizable
  // (nunca se crea un Contact así) — el orquestador lo cuenta como
  // "insufficientDataSkipped", no lo descarta silenciosamente.
  firstName: string | null;
  lastName: string | null;
  title: string | null; // texto libre, literal de la fuente — nunca se inventa
  fields: Record<string, DiscoveredField>; // firstName/lastName/title/linkedinUrl/email/phone
  sourceUrl: string | null;
}

export interface ContactProviderSearchResult {
  candidates: ContactCandidate[];
  costUsd: number; // 0 si el proveedor no está configurado o no se le llegó a pegar
  sourcesUsed: string[];
  patternsFailed: string[];
  cancelled: boolean;
  // Corrección estructural: distingue "esta empresa puntual no tiene
  // datos" (AVAILABLE, candidates vacío) de "la cuenta del proveedor no
  // puede responder nada ahora" (CREDIT_EXHAUSTED/UNAUTHORIZED/
  // UNAVAILABLE) — ver provider-health.ts.
  providerStatus: ProviderHealthStatus;
  // F27 Fase 6: créditos REALES consumidos por esta llamada (registros
  // devueltos por los que el proveedor cobra), separado de costUsd
  // (nuestra estimación en USD) -- pdl-budget.ts lo usa para descontar
  // del presupuesto de la misión sin depender de una conversión USD/crédito
  // aproximada. `undefined`/0 cuando el proveedor no se llegó a llamar,
  // falló, o no reporta este dato -- opcional a propósito para no romper
  // fixtures de tests pre-existentes que no les importa este campo
  // (people-data-labs.ts, el único proveedor de créditos reales hoy,
  // siempre lo setea explícitamente).
  creditsUsed?: number;
}

export interface ContactProviderSearchParams {
  taskId: string;
  companyName: string;
  companyWebsite: string | null;
  companyState: string | null;
  companyCity: string | null;
  industryName: string;
  // F4.6: cargos prioritarios, en orden — el proveedor los usa para
  // ordenar/filtrar su búsqueda, nunca inventa un cargo que la fuente no
  // devolvió literal.
  priorityTitles: string[];
  limit: number;
  // F27 Fase 6: techo real de resultados que el llamador autoriza para
  // ESTA llamada puntual, ya calculado contra el presupuesto mensual +
  // de la misión + por empresa (ver pdl-budget.ts) -- el proveedor nunca
  // pide más que esto, sin importar cuánto "le gustaría" pedir por su
  // propia heurística interna (ver people-data-labs.ts). `undefined` =
  // sin techo explícito del llamador (solo aplica el techo interno del
  // proveedor) -- usado por callers que todavía no pasan presupuesto.
  maxResults?: number;
  abortSignal?: AbortSignal;
}

export function emptyContactResult(): ContactProviderSearchResult {
  return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [], cancelled: false, providerStatus: "AVAILABLE", creditsUsed: 0 };
}
