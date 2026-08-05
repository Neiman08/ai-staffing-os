/**
 * F34 (auditoría arquitectónica transversal, hallazgo real crítico
 * MIS-20260805-0002, 2026-08-05): una misión real pidió 4 tipos de
 * empresa de "property maintenance" y terminó con 20 empresas de
 * industrias completamente ajenas (janitorial/landscaping/manufacturing),
 * reutilizadas en silencio del CRM -- el propio Executive Report (narrado
 * por LLM) nunca detectó la incongruencia, lo describió como una misión
 * normal con "empresas targeteadas" sin contactos todavía. La causa raíz
 * (extracción de términos literales, ver semantic-normalization.ts) ya
 * se corrigió -- este módulo es la SEGUNDA línea de defensa pedida
 * explícitamente: verificación PROGRAMÁTICA y determinista de que la
 * industria/rubro de las empresas realmente entregadas coincide con lo
 * pedido, ANTES de narrar cualquier reporte, para que una futura
 * regresión de la extracción (o cualquier otro bug futuro con el mismo
 * síntoma) nunca vuelva a pasar desapercibida.
 *
 * Puro y determinista, sin Prisma/fetch/LLM -- el llamador (mission-orchestrator.ts)
 * ya resolvió el estado real de la misión y las Companies seleccionadas.
 *
 * F34 (nota de diseño, decisión tomada tras una regresión real detectada
 * por CI): este módulo tuvo brevemente un segundo chequeo
 * (DISCOVERY_PLANNED_BUT_NEVER_EXECUTED, "el plan pedía queries de
 * descubrimiento pero 0 se ejecutaron") -- se REVIRTIÓ deliberadamente
 * después de reproducir localmente un falso positivo real: cuando la
 * instrucción prohíbe explícitamente crear campañas (allowCampaignCreation=false),
 * mission-orchestrator.ts resuelve las Companies a procesar con una
 * consulta directa (sin pasar por select_target_companies NI por
 * discover_companies, ver el comentario de diseño ahí) -- un camino
 * legítimo y preexistente donde "0 queries ejecutadas" nunca fue un bug.
 * El chequeo de industria (INDUSTRY_MISMATCH, abajo) sigue cubriendo
 * exactamente el caso real que motivó esta auditoría, sin ese riesgo de
 * falso positivo -- solo evalúa Companies que SÍ se seleccionaron.
 */

export interface MissionConsistencyCompany {
  companyId: string;
  // taxonomyKey real de la Company (ej. "roofing", "literal:property maintenance", null si nunca se determinó).
  taxonomyKey: string | null;
}

export interface MissionConsistencyInput {
  // StructuredIntent.matchedTaxonomyKeys/specificMatchedTaxonomyKeys -- rubros reales que la misión pidió, reconocidos por la taxonomía curada.
  requestedTaxonomyKeys: string[];
  // StructuredIntent.literalCompanyTypeTerms -- tipos de empresa pedidos explícitamente pero sin entrada curada.
  requestedLiteralTerms: string[];
  selectedCompanies: MissionConsistencyCompany[];
}

export interface MissionConsistencyIssue {
  code: "INDUSTRY_MISMATCH";
  detail: string;
}

export interface MissionConsistencyResult {
  consistent: boolean;
  issues: MissionConsistencyIssue[];
  matchedCompanyCount: number;
  mismatchedCompanyCount: number;
}

const LITERAL_TAXONOMY_KEY_PREFIX = "literal:";

function companyMatchesRequest(company: MissionConsistencyCompany, requestedTaxonomyKeys: string[], requestedLiteralTerms: string[]): boolean {
  if (!company.taxonomyKey) return false;
  if (requestedTaxonomyKeys.includes(company.taxonomyKey)) return true;
  if (company.taxonomyKey.startsWith(LITERAL_TAXONOMY_KEY_PREFIX)) {
    const literalTerm = company.taxonomyKey.slice(LITERAL_TAXONOMY_KEY_PREFIX.length);
    return requestedLiteralTerms.some((term) => term.toLowerCase() === literalTerm.toLowerCase());
  }
  return false;
}

/**
 * Verifica que las Companies REALMENTE seleccionadas para esta misión
 * correspondan al rubro pedido. Invariante #17 (pedida explícitamente):
 * si la industria entregada no coincide con la pedida, la misión nunca
 * puede reportarse como éxito/parcial normal.
 */
export function evaluateMissionConsistency(input: MissionConsistencyInput): MissionConsistencyResult {
  const issues: MissionConsistencyIssue[] = [];
  const hasSpecificRequest = input.requestedTaxonomyKeys.length > 0 || input.requestedLiteralTerms.length > 0;

  let matchedCompanyCount = 0;
  let mismatchedCompanyCount = 0;

  if (hasSpecificRequest && input.selectedCompanies.length > 0) {
    for (const company of input.selectedCompanies) {
      if (companyMatchesRequest(company, input.requestedTaxonomyKeys, input.requestedLiteralTerms)) matchedCompanyCount += 1;
      else mismatchedCompanyCount += 1;
    }
    // F34: inconsistencia real solo cuando NINGUNA empresa entregada
    // corresponde al rubro pedido -- una mezcla parcial (ej. bucket
    // genérico + trade específico) ya está cubierta por otros mecanismos
    // (business-validation.ts MISMATCH), esto es la red de seguridad
    // para el caso extremo real observado: 0/20 coincidían.
    if (matchedCompanyCount === 0) {
      issues.push({
        code: "INDUSTRY_MISMATCH",
        detail: `Ninguna de las ${input.selectedCompanies.length} empresa(s) seleccionada(s) corresponde a los rubros pedidos (${[...input.requestedTaxonomyKeys, ...input.requestedLiteralTerms].join(", ")}) -- posible reutilización silenciosa de empresas de otra industria.`,
      });
    }
  }

  return { consistent: issues.length === 0, issues, matchedCompanyCount, mismatchedCompanyCount };
}
