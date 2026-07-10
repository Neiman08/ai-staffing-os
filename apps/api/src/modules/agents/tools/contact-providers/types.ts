import type { DiscoveredField } from "@ai-staffing-os/agents";

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
  abortSignal?: AbortSignal;
}

export function emptyContactResult(): ContactProviderSearchResult {
  return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [], cancelled: false };
}
