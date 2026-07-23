/**
 * F14: política de conversión determinista "descubrimiento -> acción
 * comercial" -- pura, sin Prisma/fetch/LLM (mismo criterio que el resto
 * de ceo-intelligence/). Hasta esta fase, `executeDiscoveryPlan`
 * (mission-executor.ts) reunía evidencia real por empresa (validación de
 * negocio, señal de contratación, emails organizacionales, contactos
 * reales vía PDL) pero nunca la convertía en Lead/Opportunity/Draft --
 * quedaba documentado como límite explícito ("Nunca crea Lead/
 * Opportunity/Campaign/Contact") incluso cuando la misión autorizaba
 * esas acciones. Esta función es la regla única que decide, por
 * empresa, qué acción comercial corresponde -- nunca inventa datos,
 * nunca decide sola crear algo sin evidencia real, y toda Opportunity
 * que produce sigue requiriendo revisión humana (nunca se auto-aprueba
 * ni se envía nada).
 *
 * Tabla de reglas (evaluada en este orden, la primera que matchea gana):
 *
 * 1. BLOCKED_OR_DUBIOUS_IDENTITY -- businessConfidence WEAK/REJECTED, o
 *    hiringStatus BLOCKED: nunca Lead ni Opportunity.
 * 2. NO_MINIMUM_EVIDENCE -- sin ningún canal (ni email org., ni
 *    teléfono confirmado, ni sitio confirmado, ni contacto real): nunca
 *    Lead ni Opportunity, sin importar la confianza de negocio.
 * 3. EXACT_CONFIRMED_OR_LIKELY_HIRING -- EXACT + (CONFIRMED_HIRING o
 *    LIKELY_HIRING) + >=1 canal: Lead + Opportunity en revisión estándar
 *    (reviewRequired=false -- evidencia fuerte, pero SIEMPRE humano-
 *    revisada antes de avanzar, nunca auto-aprobada).
 * 4. EXACT_POSSIBLE_HIRING_WITH_EVIDENCE -- EXACT + POSSIBLE_HIRING +
 *    evidencia concreta (puestos detectados, sitio confirmado o
 *    teléfono confirmado): Lead + Opportunity marcada REVIEW_REQUIRED
 *    -- nunca "sin acción" solo porque la señal de contratación es
 *    débil.
 * 5. APPROXIMATE_SIGNAL_WITH_EVIDENCE -- APPROXIMATE + señal de
 *    contratación posible o mejor + >=1 canal: Lead de investigación +
 *    Opportunity condicionada a revisión manual (reviewRequired=true).
 * 6. NO_SIGNAL_LEAD_ONLY -- hiringStatus NO_SIGNAL o UNKNOWN, pero
 *    confianza EXACT/APPROXIMATE y >=1 canal: Lead de investigación,
 *    NUNCA Opportunity automática.
 * 7. INSUFFICIENT_EVIDENCE -- cualquier combinación no cubierta arriba
 *    (ej. APPROXIMATE sin señal positiva, o casos límite): sin acción,
 *    documentado como tal.
 */

export type BusinessConfidence = "EXACT" | "STRONG" | "APPROXIMATE" | "WEAK" | "REJECTED";
export type HiringStatus = "CONFIRMED_HIRING" | "LIKELY_HIRING" | "POSSIBLE_HIRING" | "NO_SIGNAL" | "BLOCKED" | "UNKNOWN" | null;

export interface ConversionEvidence {
  businessConfidence: BusinessConfidence;
  hiringStatus: HiringStatus;
  /** Puestos reales detectados en la página de carreras (hiring-signals.ts targetTitlesMatched). */
  hiringEvidenceConcrete: boolean;
  hasVerifiedOrgEmail: boolean;
  hasRiskyOrgEmail: boolean;
  hasConfirmedPhone: boolean;
  hasConfirmedWebsite: boolean;
  /** Contacto de persona real (PDL) con ranking HIGH_CONFIDENCE o MEDIUM_CONFIDENCE. */
  hasRealPersonContact: boolean;
}

export const conversionRules = [
  "BLOCKED_OR_DUBIOUS_IDENTITY",
  "NO_MINIMUM_EVIDENCE",
  "EXACT_CONFIRMED_OR_LIKELY_HIRING",
  "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE",
  "APPROXIMATE_SIGNAL_WITH_EVIDENCE",
  "NO_SIGNAL_LEAD_ONLY",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type ConversionRule = (typeof conversionRules)[number];

export interface ConversionDecision {
  createLead: boolean;
  createOpportunity: boolean;
  /** true = evidencia suficiente pero no la más fuerte -- la Opportunity queda explícitamente marcada como pendiente de revisión antes de avanzar (nunca "lista para actuar"). */
  opportunityReviewRequired: boolean;
  rule: ConversionRule;
  reason: string;
  hasAnyChannel: boolean;
}

function hasAnyChannel(e: ConversionEvidence): boolean {
  return e.hasVerifiedOrgEmail || e.hasRiskyOrgEmail || e.hasConfirmedPhone || e.hasConfirmedWebsite || e.hasRealPersonContact;
}

const HIRING_POSITIVE_OR_BETTER = new Set<HiringStatus>(["CONFIRMED_HIRING", "LIKELY_HIRING", "POSSIBLE_HIRING"]);

export function decideCompanyConversion(evidence: ConversionEvidence): ConversionDecision {
  const channel = hasAnyChannel(evidence);

  // 1. Bloqueado o identidad dudosa -- nunca Lead ni Opportunity, sin
  // importar cuánta evidencia de canal exista.
  if (evidence.businessConfidence === "WEAK" || evidence.businessConfidence === "REJECTED" || evidence.hiringStatus === "BLOCKED") {
    return {
      createLead: false,
      createOpportunity: false,
      opportunityReviewRequired: false,
      rule: "BLOCKED_OR_DUBIOUS_IDENTITY",
      reason: `Identidad de negocio dudosa o bloqueada (validación ${evidence.businessConfidence}${evidence.hiringStatus === "BLOCKED" ? ", señal de contratación BLOCKED" : ""}) -- nunca se crea Lead ni Opportunity.`,
      hasAnyChannel: channel,
    };
  }

  // 2. Sin ningún canal real -- no hay forma honesta de contactar a esta
  // empresa todavía, sin importar la confianza de negocio.
  if (!channel) {
    return {
      createLead: false,
      createOpportunity: false,
      opportunityReviewRequired: false,
      rule: "NO_MINIMUM_EVIDENCE",
      reason: "Sin email organizacional, teléfono confirmado, sitio confirmado ni contacto real -- evidencia insuficiente para crear Lead u Opportunity.",
      hasAnyChannel: channel,
    };
  }

  // 3. EXACT + señal de contratación confirmada o probable + canal real.
  if (evidence.businessConfidence === "EXACT" && (evidence.hiringStatus === "CONFIRMED_HIRING" || evidence.hiringStatus === "LIKELY_HIRING")) {
    return {
      createLead: true,
      createOpportunity: true,
      opportunityReviewRequired: false,
      rule: "EXACT_CONFIRMED_OR_LIKELY_HIRING",
      reason: `Validación de negocio EXACT + señal de contratación ${evidence.hiringStatus} + canal real -- Lead y Opportunity en revisión estándar.`,
      hasAnyChannel: channel,
    };
  }

  // 4. EXACT + señal posible, pero con evidencia concreta (puestos
  // reales, sitio o teléfono confirmados) -- nunca se deja sin acción.
  if (evidence.businessConfidence === "EXACT" && evidence.hiringStatus === "POSSIBLE_HIRING") {
    const concreteEvidence = evidence.hiringEvidenceConcrete || evidence.hasConfirmedWebsite || evidence.hasConfirmedPhone;
    if (concreteEvidence) {
      return {
        createLead: true,
        createOpportunity: true,
        opportunityReviewRequired: true,
        rule: "EXACT_POSSIBLE_HIRING_WITH_EVIDENCE",
        reason: "Validación de negocio EXACT + señal de contratación posible, con evidencia concreta (puestos detectados, sitio o teléfono confirmado) -- Lead y Opportunity marcada REVIEW_REQUIRED.",
        hasAnyChannel: channel,
      };
    }
  }

  // 5. APPROXIMATE (o STRONG, un escalón por debajo de EXACT -- mismo
  // criterio que business-validation.ts, que ya trata STRONG como "casi
  // EXACT" en su score 0.75 vs 0.95) + señal de contratación posible o
  // mejor + canal real -- Lead de investigación, Opportunity condicionada
  // a revisión manual. Nunca el fast-track de reviewRequired=false, eso
  // queda exclusivo de EXACT + señal confirmada/probable (regla 3).
  if (
    (evidence.businessConfidence === "APPROXIMATE" || evidence.businessConfidence === "STRONG") &&
    evidence.hiringStatus &&
    HIRING_POSITIVE_OR_BETTER.has(evidence.hiringStatus)
  ) {
    return {
      createLead: true,
      createOpportunity: true,
      opportunityReviewRequired: true,
      rule: "APPROXIMATE_SIGNAL_WITH_EVIDENCE",
      reason: `Validación de negocio ${evidence.businessConfidence} + señal de contratación ${evidence.hiringStatus} + canal real -- Lead de investigación, Opportunity condicionada a revisión manual.`,
      hasAnyChannel: channel,
    };
  }

  // 6. Sin señal de contratación (o desconocida), pero confianza de
  // negocio EXACT/APPROXIMATE y canal real -- se conserva como Lead de
  // investigación, nunca genera Opportunity automáticamente.
  if (
    (evidence.hiringStatus === "NO_SIGNAL" || evidence.hiringStatus === "UNKNOWN" || evidence.hiringStatus === null) &&
    (evidence.businessConfidence === "EXACT" || evidence.businessConfidence === "APPROXIMATE" || evidence.businessConfidence === "STRONG")
  ) {
    return {
      createLead: true,
      createOpportunity: false,
      opportunityReviewRequired: false,
      rule: "NO_SIGNAL_LEAD_ONLY",
      reason: `Sin señal de contratación confirmada (${evidence.hiringStatus ?? "no evaluada"}) -- se conserva como Lead de investigación, nunca se crea una Opportunity automáticamente.`,
      hasAnyChannel: channel,
    };
  }

  // 7. Cualquier combinación restante -- evidencia insuficiente,
  // documentado explícitamente, nunca una acción silenciosa.
  return {
    createLead: false,
    createOpportunity: false,
    opportunityReviewRequired: false,
    rule: "INSUFFICIENT_EVIDENCE",
    reason: `Combinación de evidencia insuficiente (validación ${evidence.businessConfidence}, señal ${evidence.hiringStatus ?? "no evaluada"}) para generar Lead u Opportunity.`,
    hasAnyChannel: channel,
  };
}

// F18: mismo vocabulario que Company.commercialStatus (schema.prisma) —
// reexportado acá porque conversion-policy.ts es la única fuente de
// verdad de "qué confianza de negocio habilita conversión comercial",
// nunca duplicado como un if suelto en mission-executor.ts o en los
// servicios de Lead/Opportunity.
export type CompanyCommercialStatus = "DISCOVERY_CANDIDATE" | "COMMERCIAL_VALIDATED";

/**
 * F18: única función que decide si una confianza de Business Validation
 * (business-validation.ts) alcanza para que la Company resultante sea
 * comercialmente elegible. WEAK y REJECTED (identidad de negocio dudosa
 * o explícitamente rechazada) nunca lo son -- pueden seguir
 * persistiéndose como Company (Discovery es deliberadamente amplio) pero
 * quedan marcadas DISCOVERY_CANDIDATE, nunca COMMERCIAL_VALIDATED. Se
 * llama una sola vez, en persistAcceptedCandidate (mission-executor.ts),
 * en el momento en que se conoce la confianza real.
 */
export function deriveCommercialStatus(businessConfidence: BusinessConfidence): CompanyCommercialStatus {
  return businessConfidence === "WEAK" || businessConfidence === "REJECTED" ? "DISCOVERY_CANDIDATE" : "COMMERCIAL_VALIDATED";
}

export interface BusinessIdentityGateDecision {
  allowed: boolean;
  rule: "BUSINESS_IDENTITY_VALIDATED" | "BUSINESS_IDENTITY_UNVALIDATED" | "DEMO_SEED_ORIGIN";
  reason: string;
}

/**
 * F24 (auditoría de producción): mismo vocabulario que Company.origin
 * (schema.prisma) -- reexportado acá porque conversion-policy.ts es la
 * fuente de verdad de "qué compañías pueden entrar al pipeline
 * comercial", nunca duplicado como un if suelto en otro archivo.
 */
export type CompanyOriginValue = "DEMO_SEED" | "MANUAL" | "CSV_IMPORT" | "EXTERNAL_DISCOVERY" | "API_PROVIDER";

/**
 * F18: gate OBLIGATORIO de identidad de negocio -- se evalúa en el único
 * punto de creación de Lead/Opportunity (leadsService.createLead/
 * convertLead, opportunitiesService.createOpportunity), sin importar el
 * caller (REST API manual, agente de misión, conversión de Lead) — así
 * ningún caller puede saltárselo. Es DELIBERADAMENTE un subconjunto de
 * decideCompanyConversion: solo la dimensión de identidad de negocio
 * (equivalente a su regla 1, BLOCKED_OR_DUBIOUS_IDENTITY). Nunca exige
 * evidencia de canal/hiring signal acá -- el pipeline clásico de
 * misiones (mission-orchestrator.ts) nunca calculó esa evidencia por
 * diseño, y exigirla acá bloquearía la creación de Lead para CUALQUIER
 * empresa bien clasificada, no solo las mal clasificadas. Esa evidencia
 * completa sigue siendo exclusiva de decideCompanyConversion, ya
 * aplicada en discovery-conversion.ts cuando convertToCommercialActions
 * está activo.
 *
 * F24 (auditoría de producción, hallazgo real: 8 Companies de
 * packages/db/prisma/seed.ts terminaron con ApprovalRequest reales en
 * producción): `origin` se agrega como segunda dimensión OBLIGATORIA --
 * datos sintéticos nunca son comercialmente elegibles, sin importar su
 * commercialStatus (el seed los crea COMMERCIAL_VALIDATED por default).
 * Chequeado primero porque es la condición más barata y definitiva.
 */
export function evaluateBusinessIdentityGate(commercialStatus: CompanyCommercialStatus, origin?: CompanyOriginValue | string): BusinessIdentityGateDecision {
  if (origin === "DEMO_SEED") {
    return {
      allowed: false,
      rule: "DEMO_SEED_ORIGIN",
      reason: "Esta Company es un dato de prueba/seed (origin=DEMO_SEED) -- nunca puede entrar al pipeline comercial real, sin importar su commercialStatus.",
    };
  }
  if (commercialStatus === "DISCOVERY_CANDIDATE") {
    return {
      allowed: false,
      rule: "BUSINESS_IDENTITY_UNVALIDATED",
      reason:
        "Esta Company todavía es un candidato de Discovery (confianza de negocio WEAK/REJECTED al momento de descubrirla) -- nunca se crea Lead ni Opportunity hasta que se valide su tipo de negocio (reclasificación manual o nueva evidencia).",
    };
  }
  return {
    allowed: true,
    rule: "BUSINESS_IDENTITY_VALIDATED",
    reason: "Tipo de negocio validado -- elegible para conversión comercial.",
  };
}

export interface DraftEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Los borradores de outreach SOLO se generan cuando ya existe una
 * Opportunity real (nunca antes) y hay un canal de EMAIL confiable --
 * un email organizacional VERIFIED, o un contacto de persona real con
 * ranking HIGH/MEDIUM_CONFIDENCE. Un email RISKY nunca habilita un
 * borrador (puede quedar como canal para justificar el Lead/Opportunity,
 * pero nunca para redactar un mensaje real) -- mismo criterio que
 * contact-ranking.ts ya aplica para no usar contactos de baja confianza.
 */
export function evaluateDraftEligibility(params: {
  opportunityCreated: boolean;
  hasVerifiedOrgEmail: boolean;
  hasRealPersonContactWithEmail: boolean;
}): DraftEligibility {
  if (!params.opportunityCreated) {
    return { eligible: false, reason: "No hay Opportunity creada -- nunca se redacta un borrador sin una Opportunity real detrás." };
  }
  if (params.hasVerifiedOrgEmail || params.hasRealPersonContactWithEmail) {
    return { eligible: true, reason: "Opportunity real + email verificado disponible -- borrador de outreach permitido (pendiente de aprobación humana)." };
  }
  return {
    eligible: false,
    reason: "Sin canal de email verificado -- la Opportunity queda creada, pero sin borrador. Se recomienda llamada telefónica, investigación manual o contacto directo.",
  };
}
