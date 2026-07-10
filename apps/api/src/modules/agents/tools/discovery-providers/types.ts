import type { DiscoveredField } from "@ai-staffing-os/agents";

/**
 * F4.5: contrato compartido entre proveedores de descubrimiento (Google
 * Places, Overpass) — el orquestador (discovery-tools.impl.ts) hace el
 * dedup/scoring/creación de Company una sola vez, sobre este shape común,
 * sin importar de qué proveedor vino cada candidato.
 */
export interface ProviderCandidate {
  // null = el proveedor devolvió el registro pero sin nombre utilizable
  // (nunca se crea una Company así) — el orquestador lo cuenta como
  // "insufficientDataSkipped", no lo descarta silenciosamente.
  name: string | null;
  fields: Record<string, DiscoveredField>;
  sourceUrl: string;
}

export interface ProviderSearchResult {
  candidates: ProviderCandidate[];
  costUsd: number; // 0 para proveedores gratuitos (Overpass)
  sourcesUsed: string[]; // descriptores humanos de qué se consultó con éxito
  patternsFailed: string[]; // "<motivo>" por cada intento que no devolvió nada
  cancelled: boolean;
}

export interface ProviderSearchParams {
  taskId: string;
  industryName: string;
  stateCode: string; // "IL"
  stateName: string; // "Illinois"
  city?: string;
  limit: number;
  abortSignal?: AbortSignal;
}

export function emptyResult(): ProviderSearchResult {
  return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [], cancelled: false };
}
