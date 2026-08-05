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
  // true si la misión planificó descubrimiento real (plannedSteps incluía discover_companies).
  discoveryWasPlanned: boolean;
  queriesPlanned: number;
  queriesExecuted: number;
  selectedCompanies: MissionConsistencyCompany[];
}

export interface MissionConsistencyIssue {
  code: "INDUSTRY_MISMATCH" | "DISCOVERY_PLANNED_BUT_NEVER_EXECUTED" | "NO_COMPANIES_DESPITE_QUERIES";
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
 * correspondan al rubro pedido, y que el descubrimiento se haya
 * ejecutado de verdad cuando la misión lo planificó. Invariante #17
 * (pedida explícitamente): si la industria entregada no coincide con la
 * pedida, la misión nunca puede reportarse como éxito/parcial normal.
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

  // F34: SOLO se exige cuando la misión pidió un rubro específico
  // (trade real o término literal) -- mission-orchestrator.ts fuerza
  // discovery real SIEMPRE que hasSpecificTradeMatch/hasLiteralCompanyTypeTerms
  // sea true, sin importar la oferta interna del CRM (ver el comentario
  // de diseño ahí). Para un pedido genérico ("empresas de manufactura"),
  // 0 queries ejecutadas es comportamiento LEGÍTIMO cuando el CRM ya
  // tenía oferta suficiente -- nunca se marca como inconsistencia.
  if (hasSpecificRequest && input.discoveryWasPlanned && input.queriesPlanned > 0 && input.queriesExecuted === 0) {
    issues.push({
      code: "DISCOVERY_PLANNED_BUT_NEVER_EXECUTED",
      detail: `La misión pidió un rubro específico y planificó ${input.queriesPlanned} query(s) de descubrimiento, pero ninguna se ejecutó realmente.`,
    });
  }

  return { consistent: issues.length === 0, issues, matchedCompanyCount, mismatchedCompanyCount };
}
