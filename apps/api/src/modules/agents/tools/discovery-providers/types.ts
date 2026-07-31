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
  // F16: categorías reales que el proveedor le asigna a este negocio --
  // Google Places las llama `place.types` (ej. "electrician",
  // "general_contractor"), evidencia de negocio de primera mano (el
  // proveedor categorizó ASÍ a esta empresa, no es texto de búsqueda
  // nuestro). Overpass no tiene un equivalente real -- omite el campo,
  // nunca inventa una categoría. Ver business-validation.ts, que la lee
  // como evidencia con el mismo peso que el nombre del candidato.
  providerTypes?: string[];
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
  // Bugfix multi-sector: frase de búsqueda libre (ej. "electrical
  // contractor") — si está presente, un proveedor que soporte texto
  // libre (Google Places) la usa TAL CUAL en vez de resolver una frase
  // fija a partir de industryName. Overpass no tiene búsqueda de texto
  // libre (requiere tags OSM estructurados) — la ignora, sigue
  // resolviendo por trade/industria, degradación honesta.
  queryPhrase?: string;
  // F32 (hallazgo real, MIS-20260731-0003, 2026-07-31): Overpass
  // resolvía sus patrones OSM EXCLUSIVAMENTE por crmIndustryBucket (el
  // bucket amplio del CRM, ej. "Construction") -- una query específica
  // de "electrical contractor" (taxonomyKey="electrical") terminaba
  // usando los patrones genéricos de Construction (craft=builder), sin
  // relación real con electricidad. taxonomyKey (trade/company type
  // específico, ej. "electrical", "roofing") es ahora la resolución
  // PRIMARIA para Overpass -- crmIndustryBucket abajo queda como
  // respaldo solo cuando no existe un patrón específico del trade. Un
  // proveedor que no lo necesita (Google Places, que usa queryPhrase en
  // texto libre) simplemente lo ignora.
  taxonomyKey?: string;
  crmIndustryBucket?: string | null;
  stateCode: string; // "IL"
  stateName: string; // "Illinois"
  city?: string;
  limit: number;
  abortSignal?: AbortSignal;
}

export function emptyResult(): ProviderSearchResult {
  return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [], cancelled: false };
}
