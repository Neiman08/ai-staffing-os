import type { MissionRestrictions } from "@ai-staffing-os/agents";
import { CEO_INTENT_SCHEMA_VERSION, BUSINESS_TAXONOMY_VERSION } from "@ai-staffing-os/shared";
import { getTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { getTaxonomyEntry } from "../ceo-intelligence/taxonomy";
import { SUPPORTED_STATE_CODES, NEARBY_SUPPORTED_STATES } from "../ceo-intelligence/geo";
import { normalizeText } from "../ceo-intelligence/text-normalize";
import {
  buildCompanyIdentityKeys,
  deduplicateDiscoveryCandidates,
  type CompanyIdentityKeys,
  type DiscoveryCandidateLike,
} from "../ceo-intelligence/discovery-identity";
import { validateBusinessCandidate, BUSINESS_VALIDATION_VERSION, type BusinessValidationConfidenceLevel } from "../ceo-intelligence/business-validation";
import { deriveCommercialStatus } from "../ceo-intelligence/conversion-policy";
import { computeHiringConfidence, type HiringConfidenceTier } from "../ceo-intelligence/hiring-confidence";
import { detectClientOwnerMatch } from "../ceo-intelligence/critical-infrastructure-clients";
import { createQueuedTask } from "./task-executor";
import { computeConfidenceScore } from "./tools/discovery-tools.impl";
import { searchGooglePlaces } from "./tools/discovery-providers/google-places";
import { searchOverpass } from "./tools/discovery-providers/overpass";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "./tools/provider-health";
import { getDataProviderBudgetStatus } from "./data-provider-budget";
import { enrichCompanyWithOrganizationalEmails, type WebsiteIntelligencePort } from "./company-enrichment";
import { evaluateHiringSignals, type HiringSignalResult } from "../ceo-intelligence/hiring-signals";
import { buildDecisionRolePlan, type DecisionRolePlan } from "../ceo-intelligence/role-planning";
import { enrichCompanyWithDecisionContacts, type ContactProviderPort, type HunterContactProviderPort } from "./contact-enrichment";
import { recommendOpportunityAction, type OpportunityRecommendationResult, type BestContactRankingTier } from "../ceo-intelligence/opportunity-recommendation";
import { convertDiscoveredCompany, type ConvertDiscoveredCompanyResult } from "./discovery-conversion";

/**
 * F7.3/F7.4: ejecutor real de descubrimiento a partir de un MissionPlan
 * ya generado (F7.1/F7.2, sin modificar). Reemplaza, SOLO para el flujo
 * nuevo, el patrón "por cada industria: ejecutar todos los search terms"
 * de discovery-tools.impl.ts (que sigue existiendo, sin tocar, para el
 * AgentTool discover_companies clásico) por: "por cada query única del
 * plan: ejecutar una vez, deduplicar globalmente, validar empresa,
 * persistir Company, inspeccionar website, validar emails, persistir
 * CompanyContactPoint". Pipeline completo (F7.4): (1) descubrir
 * (executeOneQuery); (2) normalizar (buildCompanyIdentityKeys); (3)
 * deduplicar (deduplicateDiscoveryCandidates); (4) validar empresa
 * (classifyCandidate -> business-validation.ts, F7.4 Parte A); (5)
 * rechazar no relevantes; (6) persistir Company (persistAcceptedCandidate);
 * (7-8) inspeccionar website + extraer emails (company-enrichment.ts,
 * envuelve Website Intelligence); (9) validar email (email-trust.ts,
 * F7.4 Parte B); (10) persistir CompanyContactPoint; (11) reporte
 * (DiscoveryExecutionReport).
 *
 * Nunca crea Campaign en este flujo. Sí crea Company, CompanyContactPoint
 * (únicamente emails VERIFIED/RISKY, nunca INVALID), Contact (F7.7,
 * People Data Labs, nunca inventado), y desde F14 también Lead/
 * Opportunity/borrador de outreach cuando la política determinista de
 * conversion-policy.ts lo autoriza (ver discovery-conversion.ts) — toda
 * Opportunity sigue requiriendo revisión humana, ningún mensaje se
 * envía automáticamente. Un AgentTask hijo de trazabilidad mínima
 * (tipo "discover_companies", igual que el flujo clásico) participa del
 * mismo guardia de presupuesto de datos en data-provider-budget.ts.
 */

const PROVIDER_KEY_GOOGLE_PLACES = "google_places_text_search";
const PROVIDER_KEY_OVERPASS = "overpass";
const GOOGLE_PLACES_RESULT_LIMIT_PER_QUERY = 20;

export interface DiscoveryProviderPort {
  searchGooglePlaces: typeof searchGooglePlaces;
  searchOverpass: typeof searchOverpass;
}

const REAL_PROVIDERS: DiscoveryProviderPort = { searchGooglePlaces, searchOverpass };

export interface ExecuteDiscoveryPlanParams {
  missionTaskId: string;
  plan: MissionPlan;
  restrictions: MissionRestrictions;
  abortSignal?: AbortSignal;
  // F7.4: labels de taxonomía matcheados por el intérprete (F7.1) — señal
  // de evidencia adicional, débil, opcional para Business Validation (ver
  // business-validation.ts). Vacío en cualquier llamador que no lo pase.
  businessActivities?: string[];
  // F7.5: StructuredIntent.targetJobTitles (F7.1) — puestos que la misión
  // pidió encontrar, usados por Hiring Signal Intelligence. Vacío en
  // cualquier llamador que no lo pase.
  targetJobTitles?: string[];
  // F7.6: StructuredIntent.decisionRoles (F7.1) — roles de decisión que
  // la misión pidió explícitamente, usados por Decision-Maker Role
  // Planning. Vacío en cualquier llamador que no lo pase.
  decisionRoles?: string[];
  // Inyección para tests — nunca se llama a un proveedor real en un test
  // unitario. Default: los módulos reales (google-places.ts/overpass.ts,
  // sin modificar).
  providers?: DiscoveryProviderPort;
  googlePlacesApiKey?: string;
  // F7.4: inyección para tests de Website Intelligence (company-enrichment.ts)
  // — nunca se llama al crawler real en un test unitario. Default: el
  // módulo real.
  websiteIntelligence?: WebsiteIntelligencePort;
  // F7.7: inyección para tests de Contact Intelligence (contact-enrichment.ts)
  // — nunca se llama a People Data Labs real en un test unitario.
  // Default: el módulo real.
  contactProvider?: ContactProviderPort;
  peopleDataLabsApiKey?: string;
  // F15: inyección para tests de la 3ra fuente de la cascada de Contact
  // Intelligence (Hunter.io) -- nunca se llama al proveedor real en un
  // test unitario. Default: el módulo real (contact-enrichment.ts).
  hunterProvider?: HunterContactProviderPort;
  hunterApiKey?: string;
  // F14: opt-in explícito -- true SOLO para el llamador que sabe que
  // este es el punto TERMINAL de la misión para estas Companies (hoy:
  // runDynamicDiscoveryMission, useExternalDiscovery=true explícito,
  // que nunca cae después en el loop clásico). Default false: mantiene
  // el comportamiento exacto de runAutoExternalDiscoveryFallback (F13),
  // cuyas Companies SÍ siguen hacia el loop clásico (select_target_
  // companies -> create_lead/create_opportunity/draft_outreach) -- ese
  // loop ya crea Lead/Opportunity real sin ningún chequeo de "¿ya existe
  // uno para esta Company?" (ver sales-tools.impl.ts), así que activar
  // la conversión ACÁ TAMBIÉN para ese llamador duplicaría Lead/
  // Opportunity por cada Company. Nunca activar sin confirmar primero
  // que el llamador es realmente terminal.
  convertToCommercialActions?: boolean;
}

export interface QueryExecutionRecord {
  query: string;
  city: string | null;
  state: string | null;
  taxonomyKey: string;
  crmIndustryBucket: string | null;
  origin: "API_PROVIDER" | "EXTERNAL_DISCOVERY" | null;
  provider: string | null;
  executedAt: string;
  rawResultCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  error: string | null;
  // F14 (refinamiento de calidad, 2026-07-19): cupo real asignado a ESTA
  // query específicamente (null cuando no aplica cupo, ej. queries
  // genéricas o de refinamiento) -- transparencia real de por qué una
  // query específica dejó de aceptar candidatos antes de agotar sus
  // resultados crudos (reserva espacio real para las demás variantes,
  // nunca deja que la primera consulta se coma todo el volumen pedido).
  queryCap: number | null;
  // 1 = ciudad+estado tal como se interpretó la instrucción; 2 =
  // refinamiento real a estado completo (la ciudad no alcanzó); 3 =
  // refinamiento real a estados vecinos soportados (el estado no
  // alcanzó) -- siempre manteniendo la industria/sector pedido fijo,
  // nunca ampliando el sector para "completar" el número.
  refinementRound: 1 | 2 | 3;
}

export interface RejectedCandidateRecord {
  name: string | null;
  taxonomyKey: string;
  reason: string;
  evidence: string;
  confidence: number;
  // F7.4: presentes solo cuando el rechazo vino de Business Validation
  // (no de los rechazos posteriores del ejecutor: bucket/Industry
  // faltante) -- ver business-validation.ts.
  matchedEvidence?: string[];
  missingEvidence?: string[];
}

// F7.4 Parte A + B: un registro por Company realmente persistida, con el
// resultado completo de Business Validation (por qué se aceptó) y el
// resumen de Email Trust (qué se encontró/persistió en su sitio) — la
// fuente única que consume la UI para "Validación de empresa" y "Emails
// organizacionales" (Mission Detail).
export interface CompanyValidationRecord {
  companyId: string;
  name: string;
  taxonomyKey: string;
  businessConfidence: BusinessValidationConfidenceLevel;
  detectedBusinessType: string | null;
  detectedSector: string | null;
  matchedEvidence: string[];
  missingEvidence: string[];
  emailsExtracted: number;
  emailsVerified: number;
  emailsRisky: number;
  emailsInvalid: number;
  companyContactPointsCreated: number;
  hasValidEmail: boolean;
  // F7.5: null cuando el plan no declaró find_hiring_signals -- nunca se
  // ejecuta ese paso "por si acaso".
  hiringStatus: HiringSignalResult["hiringStatus"] | null;
  hiringConfidence: number | null;
  targetTitlesMatched: string[];
  // F7.6: null cuando el plan no declaró find_contacts -- Decision-Maker
  // Role Planning solo corre en preparación de ese paso futuro (F7.7).
  rolePlan: DecisionRolePlan | null;
  // F7.7/F15: contactos personales reales creados para esta Company
  // (People Data Labs -> Website Intelligence -> Hunter.io, en cascada,
  // matcheados contra rolePlan.targetRoles) y los roles planificados
  // para los que ningún candidato real de NINGUNA fuente matcheó --
  // nunca se inventa un contacto de relleno para esos roles.
  contactsFound: number;
  rolesWithoutContact: string[];
  // F15 (objetivo de misión: "empresas y personas con las que
  // realmente podamos contactar", nunca solo empresas): true cuando
  // NINGUNA fuente encontró una persona real (contactsFound === 0) pero
  // sí hay un email organizacional usable (hasValidEmail) -- la Company
  // queda "lista para contacto organizacional" en vez de sin acción.
  // false tanto si ya hay un contacto real como si tampoco hay canal
  // organizacional (ver companiesPendingInvestigation en el reporte).
  readyForOrganizationalContact: boolean;
  // F16: categorías reales que el proveedor de discovery (Google Places
  // `place.types`) le asigna a esta empresa -- evidencia de negocio de
  // primera mano, ya usada (con más peso que cualquier texto) en
  // businessConfidence. Se expone acá solo para trazabilidad/UI.
  providerTypes: string[];
  // F16: clasificación (nunca exclusión automática) cuando el nombre de
  // esta Company coincide con un cliente de infraestructura crítica
  // conocido -- ver critical-infrastructure-clients.ts.
  isClientOwnerCandidate: boolean;
  clientOwnerAssociations: string[];
  // F16: segunda dimensión, INDEPENDIENTE de businessConfidence -- qué
  // tan probable es que valga la pena contactar a esta Company, combina
  // señal de contratación + página de carreras + emails + contactos
  // reales. Ver hiring-confidence.ts. Distinto de `hiringConfidence`
  // (arriba, F7.5 -- ese es solo el score fijo asociado a hiringStatus).
  hiringConfidenceTier: HiringConfidenceTier;
  hiringConfidenceConcreteEvidence: boolean;
  // F7.10: recomendación determinista sobre qué hacer con esta Company
  // -- NUNCA crea una Opportunity automáticamente, solo la prepara para
  // que el CEO (humano) decida (requiresApproval siempre true).
  opportunityRecommendation: OpportunityRecommendationResult;
  // F14: acción comercial REAL tomada (o no) para esta Company, y la
  // regla exacta aplicada -- ver conversion-policy.ts/discovery-
  // conversion.ts. A diferencia de opportunityRecommendation (arriba,
  // solo una sugerencia), esto refleja Lead/Opportunity/borrador que
  // realmente se crearon (o el motivo exacto por el que no). `null`
  // cuando el llamador no activó convertToCommercialActions (ver
  // ExecuteDiscoveryPlanParams) -- esta Company sigue hacia el loop
  // clásico, que decide su Lead/Opportunity por su cuenta.
  conversion: ConvertDiscoveredCompanyResult | null;
}

export type MissionExecutionState = "COMPLETED" | "PARTIAL" | "NO_RESULTS" | "BLOCKED" | "FAILED";

export interface DiscoveryExecutionReport {
  requestedCompanyCount: number;
  queriesPlanned: number;
  queriesExecuted: number;
  rawResults: number;
  acceptedResults: number;
  rejectedResults: number;
  duplicatesWithinMission: number;
  duplicatesAlreadyInCrm: number;
  companiesCreated: number;
  createdCompanyIds: string[];
  providersUsed: string[];
  providersOmitted: string[];
  costUsd: number;
  durationMs: number;
  stopReason: string;
  limitations: string[];
  missionState: MissionExecutionState;
  restrictionsApplied: string[];
  queryExecutions: QueryExecutionRecord[];
  rejectedCandidates: RejectedCandidateRecord[];
  // F7.4 Parte A: candidatesValidated/acceptedCompanies/rejectedCompanies
  // son alias explícitos pedidos por el PO -- mismos números que
  // acceptedResults/rejectedResults/su suma, nunca recalculados con otra
  // lógica (una sola fuente de verdad).
  candidatesValidated: number;
  acceptedCompanies: number;
  rejectedCompanies: number;
  rejectionReasons: string[];
  // F7.4 Parte B: agregados de Email Trust sobre TODAS las Companies
  // aceptadas de esta misión.
  emailsExtracted: number;
  emailsVerified: number;
  emailsRisky: number;
  emailsInvalid: number;
  emailsUnknown: number;
  companyContactPointsCreated: number;
  companiesWithoutValidEmail: number;
  validationWarnings: string[];
  companyValidations: CompanyValidationRecord[];
  // F7.5: agregados de Hiring Signal Intelligence -- todos en 0 cuando
  // el plan no declaró find_hiring_signals (nunca corre "por si acaso").
  hiringSignalsChecked: number;
  companiesConfirmedHiring: number;
  companiesLikelyHiring: number;
  companiesPossibleHiring: number;
  companiesNoHiringSignal: number;
  // F7.6: cuántas Companies recibieron un Decision-Maker Role Plan.
  rolePlansBuilt: number;
  // F7.7: agregados de Contact Intelligence -- todos en 0 cuando ninguna
  // Company tuvo un rolePlan con roles planificados (nunca corre "por
  // si acaso").
  contactCandidatesFound: number;
  contactsCreatedTotal: number;
  contactDuplicatesSkipped: number;
  contactRoleMismatchSkipped: number;
  companiesWithContactsFound: number;
  // F7.9: agregado de F7.8 (Contact Verification and Ranking) para que
  // el reporte final de la misión integre las 10 piezas pedidas por el
  // PO (intent -> plan -> discovery -> business validation -> email
  // trust -> hiring signals -> role planning -> contact intelligence ->
  // ranking -> reporte final) en un solo lugar, sin tener que ir a
  // consultar Contact por separado.
  contactsHighConfidence: number;
  contactsMediumConfidence: number;
  contactsLowConfidence: number;
  contactsRejected: number;
  // F7.10: agregados de Opportunity Recommendation -- nunca cuenta
  // Opportunities realmente creadas (eso nunca ocurre automáticamente),
  // solo cuántas Companies recibieron cada recomendación.
  companiesRecommendedForOpportunity: number;
  companiesRecommendedToInvestigate: number;
  companiesRecommendedToArchive: number;
  companiesRecommendedForManualReview: number;
  // F14: acciones comerciales REALES tomadas por la política de
  // conversión determinista (conversion-policy.ts) -- a diferencia de
  // companiesRecommendedForOpportunity (arriba, solo una sugerencia),
  // estos son conteos de Lead/Opportunity/borrador que efectivamente se
  // crearon en esta misión.
  leadsCreated: number;
  opportunitiesCreated: number;
  opportunitiesBlockedByRestriction: number;
  draftsCreated: number;
  draftsBlockedByRestriction: number;
  // F15 (objetivo de misión: "empresas y personas con las que realmente
  // podamos contactar", nunca solo empresas). Las 4 métricas de cierre
  // pedidas por el PO, calculadas sobre companyValidations -- una misión
  // nunca debería reportarse como "exitosa" mirando solo companiesCreated:
  // - companiesEnriched: encontraron AL MENOS un canal real (persona real
  //   o email organizacional verificado/riesgoso).
  // - companiesWithOrganizationalEmail: tienen hasValidEmail=true (sin
  //   importar si además se encontró una persona).
  // - companiesReadyForOrganizationalContact: sin persona real, pero con
  //   email organizacional usable -- ver CompanyValidationRecord.readyForOrganizationalContact.
  // - companiesPendingInvestigation: sin persona real Y sin ningún email
  //   organizacional -- ninguna fuente automática encontró nada, requiere
  //   investigación manual real antes de poder contactar.
  companiesEnriched: number;
  companiesWithOrganizationalEmail: number;
  companiesReadyForOrganizationalContact: number;
  companiesPendingInvestigation: number;
}

interface FinalQuery {
  searchTerm: string;
  city: string | null;
  state: string;
  taxonomyKey: string;
  crmIndustryBucket: string | null;
  // F14: 1 = ronda original (ciudad+estado interpretados), 2 = mismo
  // término sin filtro de ciudad (la ciudad no alcanzó), 3 = mismo
  // término en un estado vecino soportado (el estado no alcanzó).
  refinementRound: 1 | 2 | 3;
}

/**
 * Bugfix estructural (reemplazo del loop por-industria): recorta,
 * deduplica (case-insensitive) y descarta queries vacías o derivadas
 * exclusivamente de un término de exclusión — usa EXCLUSIVAMENTE
 * plan.searchQueries (nunca reconstruye nada a partir del texto crudo de
 * la instrucción). Combina cada searchQuery con cada ciudad planificada
 * (o una sola entrada sin ciudad si el plan no declaró ninguna) — el
 * mismo searchTerm en 2 ciudades son 2 queries reales distintas, cada
 * una se ejecuta una sola vez.
 */
export function buildFinalQueries(plan: MissionPlan, primaryState: string, options?: { citiesOverride?: (string | null)[]; refinementRound?: 1 | 2 | 3 }): FinalQuery[] {
  const cities = options?.citiesOverride ?? (plan.cities.length > 0 ? plan.cities : [null]);
  const refinementRound = options?.refinementRound ?? 1;
  const seen = new Set<string>();
  const result: FinalQuery[] = [];

  for (const q of plan.searchQueries) {
    const trimmed = q.searchTerm.trim();
    if (!trimmed) continue;

    const normalized = normalizeText(trimmed);
    const isExclusionOnly = plan.exclusions.some((ex) => normalizeText(ex.trim()) === normalized);
    if (isExclusionOnly) continue;

    for (const city of cities) {
      const dedupeKey = `${normalized}|${city ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      result.push({
        searchTerm: trimmed,
        city,
        state: primaryState,
        taxonomyKey: q.taxonomyKey,
        crmIndustryBucket: q.crmIndustryBucket,
        refinementRound,
      });
    }
  }

  return result;
}

/**
 * F14 (refinamiento de calidad, 2026-07-19): construye las rondas 2/3
 * de refinamiento progresivo -- SOLO se agregan al final de la lista de
 * queries (nunca reemplazan la ronda 1), así que el chequeo real de
 * "createdCompanyIds.length >= requestedCompanyCount" que ya existe en
 * el loop principal (executeDiscoveryPlan) decide honestamente si
 * llegan a ejecutarse -- si la ronda 1 ya alcanzó el volumen pedido, el
 * loop corta antes de tocar ninguna query de acá, cero costo real
 * agregado. Nunca amplía el SECTOR pedido -- sólo la geografía.
 */
function buildRefinementQueries(plan: MissionPlan, primaryState: string): FinalQuery[] {
  const result: FinalQuery[] = [];

  // Ronda 2: mismos términos, sin filtro de ciudad (probar todo el
  // estado) -- solo tiene sentido real si la ronda 1 SÍ tenía ciudad(es)
  // planificadas; si el plan ya era a nivel estado, repetir sería la
  // misma query exacta (0 candidatos nuevos, costo real desperdiciado).
  if (plan.cities.length > 0) {
    result.push(...buildFinalQueries(plan, primaryState, { citiesOverride: [null], refinementRound: 2 }));
  }

  // Ronda 3: mismos términos, en cada estado vecino REAL Y SOPORTADO
  // (NEARBY_SUPPORTED_STATES, geo.ts) -- degradación honesta: si el
  // estado pedido no tiene ningún vecino soportado hoy (ej. Texas),
  // esta ronda no agrega nada, nunca un vecino inventado.
  const nearby = NEARBY_SUPPORTED_STATES[primaryState] ?? [];
  for (const nearbyState of nearby) {
    result.push(...buildFinalQueries(plan, nearbyState, { citiesOverride: [null], refinementRound: 3 }));
  }

  return result;
}

function extractHttpStatus(errorText: string): number | null {
  const match = /HTTP (\d+)/.exec(errorText);
  return match?.[1] ? Number(match[1]) : null;
}

async function executeOneQuery(
  query: FinalQuery,
  deps: { taskId: string; abortSignal?: AbortSignal; providers: DiscoveryProviderPort; googlePlacesApiKey: string | undefined; tenantId: string },
): Promise<{ result: ProviderSearchResult; origin: "API_PROVIDER" | "EXTERNAL_DISCOVERY" | null; provider: string | null; omittedNote: string | null }> {
  const stateName = SUPPORTED_STATE_CODES[query.state] ?? query.state;
  let omittedNote: string | null = null;

  if (deps.googlePlacesApiKey) {
    const health = getProviderHealth(PROVIDER_KEY_GOOGLE_PLACES);
    const budget = await getDataProviderBudgetStatus(deps.tenantId);
    if (budget.exceeded) {
      omittedNote = `Google Places omitido: presupuesto de proveedor de datos excedido ($${budget.spentUsd.toFixed(2)}/$${budget.budgetUsd.toFixed(2)}).`;
    } else if (health && health.status !== "AVAILABLE") {
      omittedNote = `Google Places omitido: marcado ${health.status} (${health.reason}).`;
    } else {
      const placesResult = await deps.providers.searchGooglePlaces(
        {
          taskId: deps.taskId,
          industryName: query.crmIndustryBucket ?? query.taxonomyKey,
          queryPhrase: query.searchTerm,
          stateCode: query.state,
          stateName,
          city: query.city ?? undefined,
          limit: GOOGLE_PLACES_RESULT_LIMIT_PER_QUERY,
          abortSignal: deps.abortSignal,
        },
        deps.googlePlacesApiKey,
      );
      for (const failure of placesResult.patternsFailed) {
        const status = extractHttpStatus(failure);
        if (status != null) markProviderStatus(PROVIDER_KEY_GOOGLE_PLACES, classifyProviderHttpStatus(status), failure);
      }
      if (placesResult.candidates.length > 0 || placesResult.cancelled) {
        return { result: placesResult, origin: "API_PROVIDER", provider: "Google Places", omittedNote };
      }
      // 0 candidatos (real degradación, no error) — se intenta Overpass abajo igual.
    }
  } else {
    omittedNote = "Google Places omitido: GOOGLE_PLACES_API_KEY no configurada.";
  }

  const overpassHealth = getProviderHealth(PROVIDER_KEY_OVERPASS);
  if (overpassHealth && overpassHealth.status !== "AVAILABLE") {
    return {
      result: emptyResult(),
      origin: null,
      provider: null,
      omittedNote: `${omittedNote ?? ""} Overpass omitido: marcado ${overpassHealth.status} (${overpassHealth.reason}).`.trim(),
    };
  }
  const overpassResult = await deps.providers.searchOverpass({
    taskId: deps.taskId,
    industryName: query.crmIndustryBucket ?? "",
    stateCode: query.state,
    stateName,
    city: query.city ?? undefined,
    limit: GOOGLE_PLACES_RESULT_LIMIT_PER_QUERY,
    abortSignal: deps.abortSignal,
  });
  for (const failure of overpassResult.patternsFailed) {
    const status = extractHttpStatus(failure);
    if (status != null) markProviderStatus(PROVIDER_KEY_OVERPASS, classifyProviderHttpStatus(status), failure);
  }
  return {
    result: overpassResult,
    origin: overpassResult.candidates.length > 0 ? "EXTERNAL_DISCOVERY" : null,
    provider: overpassResult.candidates.length > 0 ? "OpenStreetMap Overpass" : null,
    omittedNote,
  };
}

interface Candidate extends DiscoveryCandidateLike {
  raw: ProviderCandidate;
  query: FinalQuery;
  origin: "API_PROVIDER" | "EXTERNAL_DISCOVERY";
}

/**
 * F16 (rediseño arquitectónico -- reemplaza el adaptador F7.4 Parte A):
 * adaptador delgado sobre validateBusinessCandidate (business-
 * validation.ts, puro). Nunca pasa `candidate.query.searchTerm` -- esa
 * dependencia (texto de búsqueda -> confianza de negocio) fue la causa
 * raíz de una regresión real, ver el comentario de diseño al inicio de
 * business-validation.ts. `providerTypes` ahora viene de
 * `candidate.raw.providerTypes` (Google Places `place.types`, ver
 * google-places.ts) -- evidencia real de la empresa, no del descubridor.
 * `description` sigue vacío hoy -- ningún proveedor de discovery
 * conectado la popula todavía en esta etapa (el crawl del sitio llega
 * recién en el enrichment posterior, F7.4 Parte B).
 */
function classifyCandidate(candidate: Candidate, plan: MissionPlan, businessActivities: string[]) {
  const website = candidate.raw.fields.website?.status === "CONFIRMED" ? (candidate.raw.fields.website.value as string) : null;
  return validateBusinessCandidate({
    candidateName: candidate.raw.name,
    website,
    taxonomyKey: candidate.query.taxonomyKey,
    city: candidate.query.city,
    state: candidate.query.state,
    missionExclusions: plan.exclusions,
    providerTypes: candidate.raw.providerTypes ?? [],
    description: null,
    businessActivities,
  });
}

/**
 * Ejecuta el paso discover_companies de un MissionPlan ya validado —
 * único punto de entrada real que llama a los proveedores externos
 * (Google Places/Overpass). Nunca crea Campaign en este flujo. Sí crea
 * Company, CompanyContactPoint, Contact (F7.7) y, desde F14, Lead/
 * Opportunity/borrador reales cuando la evidencia y las restricciones de
 * la misión lo autorizan (ver discovery-conversion.ts) — más un
 * AgentTask hijo mínimo (type: "discover_companies", igual nombre que
 * el flujo clásico para compartir el mismo guardia de presupuesto de
 * datos).
 */
export async function executeDiscoveryPlan(params: ExecuteDiscoveryPlanParams): Promise<DiscoveryExecutionReport> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const startedAt = Date.now();
  const providers = params.providers ?? REAL_PROVIDERS;
  const googlePlacesApiKey = params.googlePlacesApiKey ?? env.GOOGLE_PLACES_API_KEY;
  const requestedCompanyCount = params.plan.stopConditions.maxCompanies;
  // F16 debt fix: antes había acá un mensaje FIJO afirmando que ningún
  // proveedor poblaba providerTypes -- quedó desactualizado desde F16
  // (google-places.ts ya propaga place.types real hasta
  // BusinessValidationInput.providerTypes, ver business-validation.ts).
  // La señal honesta y ya correcta es por-candidato: business-
  // validation.ts:244 agrega "Sin provider types disponibles..." a
  // validation.warnings SOLO cuando de verdad viene vacío para ESA
  // fuente puntual (ej. Overpass, que no tiene equivalente de
  // place.types) -- eso ya llega a report.validationWarnings ("Advertencias"
  // en la UI). `limitations` queda vacío por defecto acá; cualquier
  // limitación real y actual se agrega más abajo, nunca una fija.
  const limitations: string[] = [];

  const emptyReport = (missionState: MissionExecutionState, stopReason: string): DiscoveryExecutionReport => ({
    requestedCompanyCount,
    queriesPlanned: params.plan.searchQueries.length,
    queriesExecuted: 0,
    rawResults: 0,
    acceptedResults: 0,
    rejectedResults: 0,
    duplicatesWithinMission: 0,
    duplicatesAlreadyInCrm: 0,
    companiesCreated: 0,
    createdCompanyIds: [],
    providersUsed: [],
    providersOmitted: [],
    candidatesValidated: 0,
    acceptedCompanies: 0,
    rejectedCompanies: 0,
    rejectionReasons: [],
    emailsExtracted: 0,
    emailsVerified: 0,
    emailsRisky: 0,
    emailsInvalid: 0,
    emailsUnknown: 0,
    companyContactPointsCreated: 0,
    companiesWithoutValidEmail: 0,
    validationWarnings: [],
    companyValidations: [],
    hiringSignalsChecked: 0,
    companiesConfirmedHiring: 0,
    companiesLikelyHiring: 0,
    companiesPossibleHiring: 0,
    companiesNoHiringSignal: 0,
    rolePlansBuilt: 0,
    contactCandidatesFound: 0,
    contactsCreatedTotal: 0,
    contactDuplicatesSkipped: 0,
    contactRoleMismatchSkipped: 0,
    companiesWithContactsFound: 0,
    contactsHighConfidence: 0,
    contactsMediumConfidence: 0,
    contactsLowConfidence: 0,
    contactsRejected: 0,
    companiesRecommendedForOpportunity: 0,
    companiesRecommendedToInvestigate: 0,
    companiesRecommendedToArchive: 0,
    companiesRecommendedForManualReview: 0,
    leadsCreated: 0,
    opportunitiesCreated: 0,
    opportunitiesBlockedByRestriction: 0,
    draftsCreated: 0,
    draftsBlockedByRestriction: 0,
    companiesEnriched: 0,
    companiesWithOrganizationalEmail: 0,
    companiesReadyForOrganizationalContact: 0,
    companiesPendingInvestigation: 0,
    costUsd: 0,
    durationMs: Date.now() - startedAt,
    stopReason,
    limitations,
    missionState,
    restrictionsApplied: buildRestrictionsApplied(params.restrictions),
    queryExecutions: [],
    rejectedCandidates: [],
  });

  if (!params.plan.steps.includes("discover_companies") || params.plan.searchQueries.length === 0) {
    return emptyReport("BLOCKED", "El plan no declara ningún paso/query de descubrimiento de empresas.");
  }

  const primaryState = params.plan.states[0];
  if (!primaryState || !SUPPORTED_STATE_CODES[primaryState]) {
    return emptyReport("BLOCKED", "Ningún estado soportado detectado en la instrucción — no hay área real para consultar a los proveedores.");
  }

  // F14 (refinamiento de calidad, 2026-07-19): la ronda 1 (ciudad+estado
  // interpretados, específico-antes-que-genérico ya ordenado en
  // plan.searchQueries por mission-planner.ts) va primero, seguida de
  // las rondas de refinamiento real (2: mismo término sin ciudad; 3:
  // mismo término en un estado vecino soportado) -- SIEMPRE al final,
  // nunca reemplazan la ronda 1. El chequeo real de
  // "createdCompanyIds.length >= requestedCompanyCount" en el loop de
  // abajo decide honestamente si el refinamiento llega a ejecutarse:
  // si la ronda 1 ya alcanzó el volumen pedido, cero costo real
  // adicional.
  const finalQueries = [...buildFinalQueries(params.plan, primaryState), ...buildRefinementQueries(params.plan, primaryState)];
  if (finalQueries.length === 0) {
    return emptyReport("BLOCKED", "Todas las queries planificadas quedaron vacías o eran exclusivamente términos de exclusión.");
  }

  if (!googlePlacesApiKey) {
    const overpassCoverable = finalQueries.some((q) => q.crmIndustryBucket && ["Manufacturing", "Warehouse/Logistics", "Construction"].includes(q.crmIndustryBucket));
    if (!overpassCoverable) {
      return emptyReport("BLOCKED", "Google Places no está configurada y ninguna query tiene cobertura de respaldo en Overpass (categorías fuera de Manufacturing/Warehouse-Logistics/Construction).");
    }
  }

  // AgentTask hijo de trazabilidad mínima — mismo type que el flujo
  // clásico (discover_companies) para participar del mismo guardia de
  // presupuesto de datos (data-provider-budget.ts), pero ejecutado y
  // cerrado acá mismo (nunca via AgentRuntime/runTaskInner — ese camino
  // invocaría discovery-tools.impl.ts, el AgentTool viejo con el loop
  // por-industria que este ejecutor reemplaza).
  const childTask = await createQueuedTask({
    agentKey: "discovery",
    type: "discover_companies",
    input: { searchQueries: finalQueries, requestedCompanyCount, source: "mission-executor-f7.3" },
    triggeredBy: "AGENT",
    parentTaskId: params.missionTaskId,
  });

  const queryExecutions: QueryExecutionRecord[] = [];
  const rejectedCandidates: RejectedCandidateRecord[] = [];
  const companyValidations: CompanyValidationRecord[] = [];
  const providersUsed = new Set<string>();
  const providersOmitted = new Set<string>();
  const validationWarnings = new Set<string>();
  const rejectionReasons = new Set<string>();
  const createdCompanyIds: string[] = [];
  const businessActivities = params.businessActivities ?? [];
  const targetJobTitles = params.targetJobTitles ?? [];
  const decisionRoles = params.decisionRoles ?? [];
  let totalCostUsd = 0;
  let rawResults = 0;
  let acceptedResults = 0;
  let rejectedResults = 0;
  let duplicatesWithinMission = 0;
  let duplicatesAlreadyInCrm = 0;
  let cancelled = false;
  let stopReason = "queries_exhausted";
  let emailsExtractedTotal = 0;
  let emailsVerifiedTotal = 0;
  let emailsRiskyTotal = 0;
  let emailsInvalidTotal = 0;
  let emailsUnknownTotal = 0;
  let companyContactPointsCreatedTotal = 0;
  let companiesWithoutValidEmailTotal = 0;
  let hiringSignalsChecked = 0;
  const hiringStatusCounts: Partial<Record<HiringSignalResult["hiringStatus"], number>> = {};
  let rolePlansBuilt = 0;
  let contactCandidatesFoundTotal = 0;
  let contactsCreatedTotal = 0;
  let contactDuplicatesSkippedTotal = 0;
  let contactRoleMismatchSkippedTotal = 0;
  let companiesWithContactsFoundTotal = 0;
  let contactsHighConfidenceTotal = 0;
  let contactsMediumConfidenceTotal = 0;
  let contactsLowConfidenceTotal = 0;
  let contactsRejectedTotal = 0;
  let companiesRecommendedForOpportunityTotal = 0;
  let companiesRecommendedToInvestigateTotal = 0;
  let companiesRecommendedToArchiveTotal = 0;
  let companiesRecommendedForManualReviewTotal = 0;
  // F14: política de conversión determinista (conversion-policy.ts) --
  // convierte evidencia ya reunida (validación de negocio, señal de
  // contratación, emails organizacionales, contactos reales) en Lead/
  // Opportunity/borrador real, nunca solo una recomendación. Ver
  // discovery-conversion.ts.
  let leadsCreatedTotal = 0;
  let opportunitiesCreatedTotal = 0;
  let opportunitiesBlockedByRestrictionTotal = 0;
  let draftsCreatedTotal = 0;
  let draftsBlockedByRestrictionTotal = 0;
  // F15: métricas de cierre de misión -- ver el comentario en
  // DiscoveryExecutionReport sobre por qué "solo encontramos empresas"
  // nunca debe leerse como éxito sin mirar estas 4.
  let companiesEnrichedTotal = 0;
  let companiesWithOrganizationalEmailTotal = 0;
  let companiesReadyForOrganizationalContactTotal = 0;
  let companiesPendingInvestigationTotal = 0;

  // Claves de identidad de TODAS las Companies ya existentes en el
  // tenant — CUALQUIER origen, incluido DEMO_SEED a propósito: una
  // empresa sembrada (ej. "Prairie Manufacturing Co.") nunca debe
  // aparecer como si fuera un descubrimiento nuevo, así que cuenta como
  // "ya existe" para dedup igual que cualquier Company real.
  const existingCompanies = await scopedDb.company.findMany({
    select: { name: true, website: true, phone: true, city: true, state: true, discoveryMetadata: true },
  });
  const existingKeys: Record<keyof CompanyIdentityKeys, Set<string>> = {
    providerPlaceId: new Set(),
    canonicalDomain: new Set(),
    normalizedPhone: new Set(),
    normalizedNameCityState: new Set(),
  };
  for (const existing of existingCompanies) {
    const meta = existing.discoveryMetadata as { providerPlaceId?: string } | null;
    const keys = buildCompanyIdentityKeys({
      name: existing.name,
      website: existing.website,
      phone: existing.phone,
      city: existing.city,
      state: existing.state,
      sourceUrl: null,
    });
    if (meta?.providerPlaceId) existingKeys.providerPlaceId.add(meta.providerPlaceId);
    if (keys.canonicalDomain) existingKeys.canonicalDomain.add(keys.canonicalDomain);
    if (keys.normalizedPhone) existingKeys.normalizedPhone.add(keys.normalizedPhone);
    existingKeys.normalizedNameCityState.add(keys.normalizedNameCityState);
  }

  // F14 (refinamiento de calidad, 2026-07-19): cupo real por query
  // ESPECÍFICA de la ronda 1 -- sin esto, la primera query devuelta por
  // el proveedor (hasta 20 resultados de una sola llamada) podía llenar
  // sola todo el volumen pedido antes de que corriera ninguna otra
  // variante (hallazgo real: "construction company" agotaba el cupo de
  // 10 antes de llegar a "electrical contractor"). Pesos 50/30/20% para
  // las primeras 3 queries específicas (mismo ejemplo pedido por el PO:
  // 10 empresas -> 5/3/2), 15% para variantes adicionales más allá de
  // las primeras 3. Las queries genéricas (isGenericFallback) y las de
  // refinamiento (ronda 2/3) NO tienen cupo individual -- para cuando
  // llegan a ejecutarse (si llegan) ya estamos en modo "completar lo
  // que falte", no en modo "repartir".
  const QUERY_QUOTA_WEIGHTS = [0.5, 0.3, 0.2];
  const QUERY_QUOTA_TAPER = 0.15;
  const specificRound1Keys: string[] = [];
  for (const q of finalQueries) {
    if (q.refinementRound !== 1) continue;
    const entry = getTaxonomyEntry(q.taxonomyKey);
    if (entry?.isGenericFallback) continue;
    const key = `${q.taxonomyKey}::${q.searchTerm}`;
    if (!specificRound1Keys.includes(key)) specificRound1Keys.push(key);
  }
  const queryCapByKey = new Map<string, number>();
  specificRound1Keys.forEach((key, index) => {
    const weight = QUERY_QUOTA_WEIGHTS[index] ?? QUERY_QUOTA_TAPER;
    queryCapByKey.set(key, Math.max(1, Math.ceil(requestedCompanyCount * weight)));
  });
  const acceptedByQueryKey = new Map<string, number>();

  outer: for (const query of finalQueries) {
    if (createdCompanyIds.length >= requestedCompanyCount) {
      stopReason = "limit_reached";
      break outer;
    }
    if (params.abortSignal?.aborted) {
      cancelled = true;
      stopReason = "cancelled";
      break outer;
    }

    const queryKey = `${query.taxonomyKey}::${query.searchTerm}`;
    const queryCap = queryCapByKey.get(queryKey) ?? null;
    if (queryCap !== null && (acceptedByQueryKey.get(queryKey) ?? 0) >= queryCap) {
      // F14: esta query específica ya alcanzó su cupo -- reserva
      // espacio real para las demás variantes específicas en vez de
      // seguir aceptando más de la misma, nunca ejecuta el request de
      // nuevo para descartarlo (costo real evitado).
      continue;
    }

    const { result, origin, provider, omittedNote } = await executeOneQuery(query, {
      taskId: childTask.id,
      abortSignal: params.abortSignal,
      providers,
      googlePlacesApiKey,
      tenantId: ctx.tenantId,
    });
    if (omittedNote) providersOmitted.add(omittedNote);
    if (result.costUsd > 0) totalCostUsd += result.costUsd;
    if (provider) providersUsed.add(provider);
    if (result.cancelled) {
      cancelled = true;
      stopReason = "cancelled";
    }

    const record: QueryExecutionRecord = {
      query: query.searchTerm,
      city: query.city,
      state: query.state,
      taxonomyKey: query.taxonomyKey,
      crmIndustryBucket: query.crmIndustryBucket,
      origin,
      provider,
      executedAt: new Date().toISOString(),
      rawResultCount: result.candidates.length,
      acceptedCount: 0,
      queryCap,
      refinementRound: query.refinementRound,
      rejectedCount: 0,
      duplicateCount: 0,
      error: result.candidates.length === 0 && result.patternsFailed.length > 0 ? result.patternsFailed.join("; ") : null,
    };
    rawResults += result.candidates.length;

    if (origin) {
      const candidates: Candidate[] = result.candidates.map((raw) => ({
        raw,
        query,
        origin,
        identity: buildCompanyIdentityKeys({
          name: raw.name,
          website: raw.fields.website?.status === "CONFIRMED" ? (raw.fields.website.value as string) : null,
          phone: raw.fields.phone?.status === "CONFIRMED" ? (raw.fields.phone.value as string) : null,
          city: raw.fields.city?.status === "CONFIRMED" ? (raw.fields.city.value as string) : query.city,
          // F14: preferir el estado CONFIRMADO del propio candidato, igual
          // que city arriba -- antes de refinamiento geográfico query.state
          // siempre coincidía con el estado real (un solo estado por plan),
          // así que esta rama nunca se ejercitaba. Con refinamiento
          // (rondas 3, estados vecinos) query.state pasa a ser el estado
          // BUSCADO, no necesariamente el real del candidato -- sin esto,
          // una empresa ya conocida en IL redescubierta vía una query
          // ampliada a IN generaría una clave "...|chicago|in" que nunca
          // matchea contra la Company real "...|chicago|il" ya existente,
          // rompiendo el dedup silenciosamente.
          state: raw.fields.state?.status === "CONFIRMED" ? (raw.fields.state.value as string) : query.state,
          sourceUrl: raw.sourceUrl,
        }),
      }));

      const { unique, duplicates } = deduplicateDiscoveryCandidates(candidates, existingKeys);
      for (const dup of duplicates) {
        duplicatesWithinMission += 1;
        record.duplicateCount += 1;
        // Si matcheó contra existingKeys (ya sembrado antes del loop) es
        // "ya en el CRM"; si matcheó contra una clave agregada DURANTE
        // este mismo loop, es un duplicado dentro de la misión — ambos
        // ya se contaron arriba en duplicatesWithinMission; separamos acá
        // solo para el conteo fino del reporte ejecutivo.
        if (isPreexisting(dup.matchedOn, dup.duplicateOfKey, existingCompanies, existingKeys)) duplicatesAlreadyInCrm += 1;
      }

      for (const candidate of unique) {
        if (createdCompanyIds.length >= requestedCompanyCount) break;
        // F14: cupo real de ESTA query específica agotado -- deja el
        // resto de este mismo batch de resultados sin procesar, reserva
        // el espacio real para las demás variantes específicas.
        if (queryCap !== null && (acceptedByQueryKey.get(queryKey) ?? 0) >= queryCap) break;

        // Registrar la clave ya aceptada para que un candidato posterior
        // (misma query u otra) que coincida se trate como duplicado —
        // deduplicateDiscoveryCandidates ya lo hace DENTRO de esta misma
        // llamada, pero acá se propaga entre queries distintas.
        for (const field of ["providerPlaceId", "canonicalDomain", "normalizedPhone", "normalizedNameCityState"] as const) {
          const value = candidate.identity[field];
          if (value) existingKeys[field].add(value);
        }

        const validation = classifyCandidate(candidate, params.plan, businessActivities);
        for (const warning of validation.warnings) validationWarnings.add(warning);

        if (!validation.accepted) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          const reason = validation.rejectionReasons.join(" ");
          rejectionReasons.add(reason);
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason,
            evidence: candidate.raw.name ?? candidate.raw.sourceUrl,
            confidence: validation.confidenceScore,
          });
          continue;
        }

        if (!candidate.query.crmIndustryBucket) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          const reason = `Sin bucket de Industry real aprobado para la categoría "${candidate.query.taxonomyKey}" — decisión pendiente del PO (ver plan §9.4). No se persiste hasta que se apruebe/cree la Industry correspondiente.`;
          rejectionReasons.add(reason);
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason,
            evidence: candidate.raw.name ?? candidate.raw.sourceUrl,
            confidence: 1,
            matchedEvidence: validation.matchedEvidence,
            missingEvidence: validation.missingEvidence,
          });
          continue;
        }

        const industry = await scopedDb.industry.findFirst({ where: { name: candidate.query.crmIndustryBucket } });
        if (!industry) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          const reason = `Industry real "${candidate.query.crmIndustryBucket}" no existe en el CRM de este tenant.`;
          rejectionReasons.add(reason);
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason,
            evidence: candidate.raw.name ?? candidate.raw.sourceUrl,
            confidence: 1,
            matchedEvidence: validation.matchedEvidence,
            missingEvidence: validation.missingEvidence,
          });
          continue;
        }

        const company = await persistAcceptedCandidate({
          candidate,
          industryId: industry.id,
          confidenceScore: computeConfidenceScore(candidate.raw.fields),
          businessValidation: validation,
          missionTaskId: childTask.id,
        });
        createdCompanyIds.push(company.id);
        acceptedResults += 1;
        record.acceptedCount += 1;
        if (queryCap !== null) acceptedByQueryKey.set(queryKey, (acceptedByQueryKey.get(queryKey) ?? 0) + 1);
        // F16: mismo cálculo que dentro de persistAcceptedCandidate (ver
        // discoveryMetadata.clientOwnerAssociations) -- se repite acá,
        // barato y puro, para exponerlo también en CompanyValidationRecord
        // sin acoplar este loop al Json interno de discoveryMetadata.
        const clientOwnerMatchesForCandidate = detectClientOwnerMatch(candidate.raw.name);

        // F7.10 fix: los pasos F7.5/F7.6/F7.10 escriben cada uno su
        // propia clave en Company.discoveryMetadata -- `company` nunca
        // se refresca tras un update, así que sin este acumulador
        // local cada escritura pisaba la anterior (ej. rolePlan
        // borraba hiringSignal, opportunityRecommendation borraba
        // ambos). Se mantiene una única fuente de verdad en memoria y
        // se persiste completa en cada paso.
        let currentDiscoveryMetadata = (company.discoveryMetadata as object | null) ?? {};

        // F7.4 Parte B, pasos 7-10 del pipeline: inspeccionar website ->
        // extraer emails -> validar -> persistir CompanyContactPoint —
        // solo para Companies genuinamente nuevas (no se re-enriquece
        // nada que ya existía, esas nunca pasan por acá).
        const enrichment = await enrichCompanyWithOrganizationalEmails({
          taskId: childTask.id,
          companyId: company.id,
          abortSignal: params.abortSignal,
          websiteIntelligence: params.websiteIntelligence,
        });
        emailsExtractedTotal += enrichment.emailsExtracted;
        emailsVerifiedTotal += enrichment.emailsVerified;
        emailsRiskyTotal += enrichment.emailsRisky;
        emailsInvalidTotal += enrichment.emailsInvalid;
        emailsUnknownTotal += enrichment.emailsUnknown;
        companyContactPointsCreatedTotal += enrichment.companyContactPointsCreated;
        const hasValidEmail = enrichment.emailsVerified > 0 || enrichment.emailsRisky > 0;
        if (!hasValidEmail) companiesWithoutValidEmailTotal += 1;
        for (const failure of enrichment.patternsFailed) validationWarnings.add(failure);
        // F7.9: propagar cancelación de Website Intelligence -- sin esto,
        // una cancelación a mitad de la corrida seguía disparando pasos
        // pagos (F7.7) para el resto de candidatos/queries, violando la
        // condición de parada pedida por el usuario. Los pasos
        // siguientes (F7.5-F7.7) se saltan para ESTE candidato y para
        // cualquier otro que quede en el batch -- el registro parcial ya
        // reunido igual se reporta abajo (nunca se descarta un Company
        // ya persistido).
        if (enrichment.cancelled) {
          cancelled = true;
          stopReason = "cancelled";
        }

        // F7.5: Hiring Signal Intelligence — paso opcional del plan
        // (find_hiring_signals), nunca corre si el plan no lo declaró.
        // Reutiliza EXACTAMENTE el mismo crawl que ya hizo el
        // enriquecimiento de emails (enrichment.websiteSignals) — jamás
        // un segundo request al mismo sitio.
        let hiringSignal: HiringSignalResult | null = null;
        if (!cancelled && params.plan.steps.includes("find_hiring_signals")) {
          const taxonomyEntry = getTaxonomyEntry(candidate.query.taxonomyKey);
          hiringSignal = evaluateHiringSignals({
            companyId: company.id,
            hasWebsite: enrichment.websiteSignals.hasWebsite,
            crawlBlocked: enrichment.websiteSignals.crawlBlocked,
            hasCareersPage: enrichment.websiteSignals.hasCareersPage,
            careersPageUrl: enrichment.websiteSignals.careersPageUrl,
            pageTexts: enrichment.websiteSignals.pageTexts,
            targetJobTitles,
            taxonomyJobTitles: taxonomyEntry?.jobTitles ?? [],
          });
          hiringSignalsChecked += 1;
          hiringStatusCounts[hiringSignal.hiringStatus] = (hiringStatusCounts[hiringSignal.hiringStatus] ?? 0) + 1;
          for (const warning of hiringSignal.warnings) validationWarnings.add(warning);
          currentDiscoveryMetadata = { ...currentDiscoveryMetadata, hiringSignal };
          await scopedDb.company.update({
            where: { id: company.id },
            data: { discoveryMetadata: currentDiscoveryMetadata as never },
          });
        }

        // F7.6: Decision-Maker Role Planning — QUÉ roles buscar, nunca
        // QUIÉN (eso es Contact Intelligence, F7.7, todavía no
        // implementado). Corre solo cuando el plan declara find_contacts
        // (preparación para esa fase futura) — nunca "por si acaso".
        let rolePlan: DecisionRolePlan | null = null;
        if (!cancelled && params.plan.steps.includes("find_contacts")) {
          const taxonomyEntryForRoles = getTaxonomyEntry(candidate.query.taxonomyKey);
          rolePlan = buildDecisionRolePlan({
            companyId: company.id,
            taxonomyKey: candidate.query.taxonomyKey,
            intentDecisionRoles: decisionRoles,
            taxonomyDecisionMakers: taxonomyEntryForRoles?.decisionMakers ?? [],
            hiringStatus: hiringSignal?.hiringStatus ?? null,
            missionExclusions: params.plan.exclusions,
          });
          rolePlansBuilt += 1;
          currentDiscoveryMetadata = { ...currentDiscoveryMetadata, rolePlan };
          await scopedDb.company.update({
            where: { id: company.id },
            data: { discoveryMetadata: currentDiscoveryMetadata as never },
          });
        }

        // F7.7: Contact Intelligence -- QUIÉN (persona real), solo
        // cuando F7.6 planificó al menos un rol para esta Company.
        // Nunca busca con una lista de cargos genérica ni "por si
        // acaso" -- si rolePlan es null o no tiene roles, el paso ni
        // siquiera llama al proveedor (costo real $0 en ese caso).
        let contactsFoundForCompany = 0;
        let rolesWithoutContactForCompany: string[] = [];
        let bestContactRankingTierForCompany: BestContactRankingTier = null;
        // F14: id del mejor contacto real (HIGH/MEDIUM_CONFIDENCE) para
        // esta Company -- usado más abajo para conversión a Lead/
        // Opportunity/borrador. Nunca un nombre inventado: viene de un
        // Contact ya persistido por Contact Intelligence (F7.7, PDL).
        let bestContactIdForCompany: string | null = null;
        if (!cancelled && rolePlan && rolePlan.targetRoles.length > 0) {
          const contactEnrichment = await enrichCompanyWithDecisionContacts({
            taskId: childTask.id,
            companyId: company.id,
            companyName: candidate.raw.name!,
            companyWebsite: company.website,
            companyState: company.state,
            companyCity: company.city,
            industryName: industry.name,
            rolePlan,
            abortSignal: params.abortSignal,
            contactProvider: params.contactProvider,
            peopleDataLabsApiKey: params.peopleDataLabsApiKey,
            // F15: 2da y 3ra fuente de la cascada -- namedPeople viene
            // del MISMO crawl que ya hizo enrichCompanyWithOrganizationalEmails
            // arriba (nunca un segundo request al sitio); Hunter corre
            // solo si PDL+Website no cubrieron todos los roles.
            websiteNamedPeople: enrichment.websiteSignals.namedPeople,
            hunterProvider: params.hunterProvider,
            hunterApiKey: params.hunterApiKey,
          });
          if (contactEnrichment.costUsd > 0) totalCostUsd += contactEnrichment.costUsd;
          for (const source of contactEnrichment.sourcesUsed) providersUsed.add(source);
          // F16 debt fix: antes providersOmitted SOLO se poblaba desde
          // executeOneQuery (Google Places/Overpass) -- People Data
          // Labs/Hunter.io nunca aparecían acá aunque genuinamente se
          // hayan omitido por falta de credenciales o presupuesto
          // excedido (ver contact-enrichment.ts, que ahora separa esos
          // 2 motivos de patternsFailed). Mismo Set que ya usa la capa
          // de discovery -- un solo providersOmitted real para toda la
          // misión, nunca dos fuentes de verdad distintas.
          for (const omitted of contactEnrichment.providersOmitted) providersOmitted.add(omitted);
          contactCandidatesFoundTotal += contactEnrichment.candidatesFound;
          contactsCreatedTotal += contactEnrichment.contactsCreated.length;
          contactDuplicatesSkippedTotal += contactEnrichment.duplicatesSkipped;
          contactRoleMismatchSkippedTotal += contactEnrichment.roleMismatchSkipped;
          contactsFoundForCompany = contactEnrichment.contactsCreated.length;
          rolesWithoutContactForCompany = contactEnrichment.rolesWithoutContact;
          if (contactsFoundForCompany > 0) companiesWithContactsFoundTotal += 1;
          const tierRank: Record<Exclude<BestContactRankingTier, null>, number> = {
            HIGH_CONFIDENCE: 3,
            MEDIUM_CONFIDENCE: 2,
            LOW_CONFIDENCE: 1,
            REJECTED: 0,
          };
          for (const created of contactEnrichment.contactsCreated) {
            if (created.rankingTier === "HIGH_CONFIDENCE") contactsHighConfidenceTotal += 1;
            else if (created.rankingTier === "MEDIUM_CONFIDENCE") contactsMediumConfidenceTotal += 1;
            else if (created.rankingTier === "LOW_CONFIDENCE") contactsLowConfidenceTotal += 1;
            else if (created.rankingTier === "REJECTED") contactsRejectedTotal += 1;
            if (bestContactRankingTierForCompany === null || tierRank[created.rankingTier] > tierRank[bestContactRankingTierForCompany]) {
              bestContactRankingTierForCompany = created.rankingTier;
              bestContactIdForCompany = created.contactId;
            }
          }
          for (const failure of contactEnrichment.patternsFailed) validationWarnings.add(failure);
          // F7.9: misma razón que enrichment.cancelled arriba -- People
          // Data Labs es un proveedor PAGO, así que ignorar esta
          // cancelación sería el caso con mayor impacto real de
          // presupuesto de los tres.
          if (contactEnrichment.cancelled) {
            cancelled = true;
            stopReason = "cancelled";
          }
        }

        // F7.10: Opportunity Recommendation -- combina TODA la evidencia
        // ya reunida arriba en una recomendación auditable. Corre
        // siempre (a diferencia de F7.5-F7.7, no depende de un paso
        // opcional del plan) porque Business Validation (F7.4) también
        // corre siempre. Nunca crea una Opportunity -- requiresApproval
        // siempre true, la decisión real queda para el CEO humano.
        const opportunityRecommendation = recommendOpportunityAction({
          businessConfidence: validation.confidence,
          missingEvidence: validation.missingEvidence,
          hasValidEmail,
          hiringStatus: hiringSignal?.hiringStatus ?? null,
          contactsFound: contactsFoundForCompany,
          bestContactRankingTier: bestContactRankingTierForCompany,
          rolesWithoutContact: rolesWithoutContactForCompany,
        });
        if (opportunityRecommendation.recommendation === "CREATE_OPPORTUNITY") companiesRecommendedForOpportunityTotal += 1;
        else if (opportunityRecommendation.recommendation === "INVESTIGATE_MORE") companiesRecommendedToInvestigateTotal += 1;
        else if (opportunityRecommendation.recommendation === "ARCHIVE") companiesRecommendedToArchiveTotal += 1;
        else if (opportunityRecommendation.recommendation === "MANUAL_REVIEW") companiesRecommendedForManualReviewTotal += 1;
        currentDiscoveryMetadata = { ...currentDiscoveryMetadata, opportunityRecommendation };
        await scopedDb.company.update({
          where: { id: company.id },
          data: { discoveryMetadata: currentDiscoveryMetadata as never },
        });

        // F14: convierte la evidencia ya reunida arriba (nunca datos
        // nuevos) en Lead/Opportunity/borrador reales, según la política
        // determinista de conversion-policy.ts -- reemplaza el límite
        // documentado hasta esta fase ("nunca crea Lead/Opportunity").
        // El registro parcial ya reunido se usa igual aunque `cancelled`
        // ya sea true (mismo criterio que el resto de este loop: nunca
        // se descarta evidencia real ya juntada). SOLO corre si el
        // llamador activó convertToCommercialActions -- ver el
        // comentario en ExecuteDiscoveryPlanParams (nunca duplicar la
        // creación de Lead/Opportunity que ya hace el loop clásico para
        // el llamador de fallback).
        // F16: Hiring Confidence -- segunda dimensión INDEPENDIENTE de
        // Business Confidence (validation.confidence), calculada SIEMPRE
        // (no solo cuando convertToCommercialActions está activo -- es
        // una lectura pura de evidencia ya reunida, Commercial Conversion
        // es solo uno de sus consumidores) combinando señal de
        // contratación + página de carreras + emails organizacionales +
        // contactos reales ya encontrados. Reemplaza el chequeo anterior,
        // más angosto, que solo miraba `targetTitlesMatched.length > 0`
        // -- ahora también reconoce evidencia real de contact enrichment
        // (F7.6/F7.7/F15).
        const hiringConfidence = computeHiringConfidence({
          hiringSignalStatus: hiringSignal?.hiringStatus ?? null,
          hiringSignalTitlesMatched: hiringSignal?.targetTitlesMatched ?? [],
          hasCareersPage: enrichment.websiteSignals.hasCareersPage,
          organizationalEmailsVerified: enrichment.emailsVerified,
          organizationalEmailsRisky: enrichment.emailsRisky,
          namedContactsFound: contactsFoundForCompany,
          bestContactRankingTier: bestContactRankingTierForCompany,
        });
        currentDiscoveryMetadata = { ...currentDiscoveryMetadata, hiringConfidence };
        await scopedDb.company.update({
          where: { id: company.id },
          data: { discoveryMetadata: currentDiscoveryMetadata as never },
        });

        let conversion: ConvertDiscoveredCompanyResult | null = null;
        if (params.convertToCommercialActions) {
          const bestVerifiedOrgEmail = enrichment.emails.find((e) => e.status === "VERIFIED")?.email ?? null;
          let bestRealContact: { contactId: string; firstName: string; lastName: string; email: string | null } | null = null;
          if (bestContactIdForCompany && (bestContactRankingTierForCompany === "HIGH_CONFIDENCE" || bestContactRankingTierForCompany === "MEDIUM_CONFIDENCE")) {
            const contactRow = await scopedDb.contact.findUnique({
              where: { id: bestContactIdForCompany },
              select: { id: true, firstName: true, lastName: true, email: true },
            });
            if (contactRow) {
              bestRealContact = { contactId: contactRow.id, firstName: contactRow.firstName, lastName: contactRow.lastName, email: contactRow.email };
            }
          }
          conversion = await convertDiscoveredCompany({
            taskId: childTask.id,
            company: { id: company.id, name: candidate.raw.name!, industryId: industry.id },
            restrictions: params.restrictions,
            evidence: {
              businessConfidence: validation.confidence,
              hiringStatus: hiringSignal?.hiringStatus ?? null,
              hiringEvidenceConcrete: hiringConfidence.concreteEvidence,
              hasVerifiedOrgEmail: !!bestVerifiedOrgEmail,
              hasRiskyOrgEmail: enrichment.emailsRisky > 0,
              hasConfirmedPhone: !!company.phone,
              hasConfirmedWebsite: !!company.website,
              hasRealPersonContact: !!bestRealContact,
            },
            bestVerifiedOrgEmail,
            bestRealContact,
          });
          if (conversion.leadId) leadsCreatedTotal += 1;
          if (conversion.opportunityId) opportunitiesCreatedTotal += 1;
          if (conversion.opportunityBlockedByRestriction) opportunitiesBlockedByRestrictionTotal += 1;
          if (conversion.draftCreated) draftsCreatedTotal += 1;
          if (conversion.draftBlockedByRestriction) draftsBlockedByRestrictionTotal += 1;
        }

        // F15: "empresas y personas con las que realmente podamos
        // contactar" -- calculado con la MISMA evidencia ya reunida
        // arriba (contactsFoundForCompany de la cascada F7.7/F15,
        // hasValidEmail de Email Trust F7.4), nunca un dato nuevo.
        const readyForOrganizationalContact = contactsFoundForCompany === 0 && hasValidEmail;
        if (contactsFoundForCompany > 0 || hasValidEmail) companiesEnrichedTotal += 1;
        if (hasValidEmail) companiesWithOrganizationalEmailTotal += 1;
        if (readyForOrganizationalContact) companiesReadyForOrganizationalContactTotal += 1;
        if (contactsFoundForCompany === 0 && !hasValidEmail) companiesPendingInvestigationTotal += 1;

        companyValidations.push({
          companyId: company.id,
          name: candidate.raw.name!,
          taxonomyKey: candidate.query.taxonomyKey,
          businessConfidence: validation.confidence,
          detectedBusinessType: validation.detectedBusinessType,
          detectedSector: validation.detectedSector,
          matchedEvidence: validation.matchedEvidence,
          missingEvidence: validation.missingEvidence,
          emailsExtracted: enrichment.emailsExtracted,
          emailsVerified: enrichment.emailsVerified,
          emailsRisky: enrichment.emailsRisky,
          emailsInvalid: enrichment.emailsInvalid,
          companyContactPointsCreated: enrichment.companyContactPointsCreated,
          hasValidEmail,
          hiringStatus: hiringSignal?.hiringStatus ?? null,
          hiringConfidence: hiringSignal?.confidence ?? null,
          targetTitlesMatched: hiringSignal?.targetTitlesMatched ?? [],
          rolePlan,
          contactsFound: contactsFoundForCompany,
          rolesWithoutContact: rolesWithoutContactForCompany,
          opportunityRecommendation,
          conversion,
          readyForOrganizationalContact,
          providerTypes: candidate.raw.providerTypes ?? [],
          isClientOwnerCandidate: clientOwnerMatchesForCandidate.length > 0,
          clientOwnerAssociations: clientOwnerMatchesForCandidate,
          hiringConfidenceTier: hiringConfidence.tier,
          hiringConfidenceConcreteEvidence: hiringConfidence.concreteEvidence,
        });
        // F7.9: cortar el loop de candidatos de ESTA query inmediatamente
        // al detectar cancelación -- sin este break, el resto de
        // candidatos de la misma query seguían corriendo pasos pagos
        // (F7.7) hasta el chequeo original de más abajo, que solo
        // rompía el loop de queries, no el de candidatos.
        if (cancelled) break;
      }
    }

    queryExecutions.push(record);
    if (cancelled) break outer;
  }

  // F14: la cancelación real (abortSignal / proveedor pago cancelado a
  // mitad de un candidato) siempre debe ganar sobre "limit_reached" --
  // antes de bajar el target por defecto de este archivo de 5 a 1, esta
  // condición nunca coincidía con `cancelled` en los fixtures de test,
  // así que el orden nunca importaba. Con un target más chico es normal
  // que "se canceló" y "se llegó al target" pasen en la misma query;
  // reportar "limit_reached" ahí ocultaría la cancelación real.
  if (!cancelled && createdCompanyIds.length >= requestedCompanyCount) stopReason = "limit_reached";

  const missionState: MissionExecutionState = cancelled
    ? "PARTIAL"
    : createdCompanyIds.length >= requestedCompanyCount
      ? "COMPLETED"
      : createdCompanyIds.length > 0
        ? "PARTIAL"
        : "NO_RESULTS";

  await logActivity({
    entityType: "mission",
    entityId: params.missionTaskId,
    type: "SYSTEM",
    subject: `Descubrimiento ejecutado: ${createdCompanyIds.length} empresa(s) nueva(s) de ${finalQueries.length} query(ies) planificadas.`,
  });
  await logAuditEvent({
    action: "mission.discovery_executed",
    entityType: "mission",
    entityId: params.missionTaskId,
    after: { companiesCreated: createdCompanyIds.length, queriesExecuted: queryExecutions.length, missionState, costUsd: totalCostUsd },
  });

  await scopedDb.agentTask.update({
    where: { id: childTask.id },
    data: {
      status: "DONE",
      completedAt: new Date(),
      costUsd: totalCostUsd,
      output: { queryExecutions, createdCompanyIds, rejectedCandidates, companyValidations, missionState } as never,
    },
  });

  return {
    requestedCompanyCount,
    queriesPlanned: params.plan.searchQueries.length,
    queriesExecuted: queryExecutions.length,
    rawResults,
    acceptedResults,
    rejectedResults,
    duplicatesWithinMission,
    duplicatesAlreadyInCrm,
    companiesCreated: createdCompanyIds.length,
    createdCompanyIds,
    providersUsed: Array.from(providersUsed),
    providersOmitted: Array.from(providersOmitted),
    candidatesValidated: acceptedResults + rejectedResults,
    acceptedCompanies: createdCompanyIds.length,
    rejectedCompanies: rejectedResults,
    rejectionReasons: Array.from(rejectionReasons),
    emailsExtracted: emailsExtractedTotal,
    emailsVerified: emailsVerifiedTotal,
    emailsRisky: emailsRiskyTotal,
    emailsInvalid: emailsInvalidTotal,
    emailsUnknown: emailsUnknownTotal,
    companyContactPointsCreated: companyContactPointsCreatedTotal,
    companiesWithoutValidEmail: companiesWithoutValidEmailTotal,
    validationWarnings: Array.from(validationWarnings),
    companyValidations,
    hiringSignalsChecked,
    companiesConfirmedHiring: hiringStatusCounts.CONFIRMED_HIRING ?? 0,
    companiesLikelyHiring: hiringStatusCounts.LIKELY_HIRING ?? 0,
    companiesPossibleHiring: hiringStatusCounts.POSSIBLE_HIRING ?? 0,
    companiesNoHiringSignal: hiringStatusCounts.NO_SIGNAL ?? 0,
    rolePlansBuilt,
    contactCandidatesFound: contactCandidatesFoundTotal,
    contactsCreatedTotal,
    contactDuplicatesSkipped: contactDuplicatesSkippedTotal,
    contactRoleMismatchSkipped: contactRoleMismatchSkippedTotal,
    companiesWithContactsFound: companiesWithContactsFoundTotal,
    contactsHighConfidence: contactsHighConfidenceTotal,
    contactsMediumConfidence: contactsMediumConfidenceTotal,
    contactsLowConfidence: contactsLowConfidenceTotal,
    contactsRejected: contactsRejectedTotal,
    companiesRecommendedForOpportunity: companiesRecommendedForOpportunityTotal,
    companiesRecommendedToInvestigate: companiesRecommendedToInvestigateTotal,
    companiesRecommendedToArchive: companiesRecommendedToArchiveTotal,
    companiesRecommendedForManualReview: companiesRecommendedForManualReviewTotal,
    leadsCreated: leadsCreatedTotal,
    opportunitiesCreated: opportunitiesCreatedTotal,
    opportunitiesBlockedByRestriction: opportunitiesBlockedByRestrictionTotal,
    draftsCreated: draftsCreatedTotal,
    draftsBlockedByRestriction: draftsBlockedByRestrictionTotal,
    companiesEnriched: companiesEnrichedTotal,
    companiesWithOrganizationalEmail: companiesWithOrganizationalEmailTotal,
    companiesReadyForOrganizationalContact: companiesReadyForOrganizationalContactTotal,
    companiesPendingInvestigation: companiesPendingInvestigationTotal,
    costUsd: totalCostUsd,
    durationMs: Date.now() - startedAt,
    stopReason,
    limitations,
    missionState,
    restrictionsApplied: buildRestrictionsApplied(params.restrictions),
    queryExecutions,
    rejectedCandidates,
  };
}

// F14 (corrección de causa raíz): antes esta función SIEMPRE agregaba
// "No se crea ninguna Lead/Opportunity/Campaign/Contact en este flujo"
// como primera nota, sin importar lo que restrictions realmente
// autorizara -- una misión que autorizaba campañas/oportunidades/
// outreach/mensajes igual mostraba esa nota como si fuera una
// restricción real de la instrucción, cuando en realidad era un límite
// del CÓDIGO (F7.3, antes de esta fase) que ya no existe: esta función
// ahora solo reporta restricciones REALES (lo que la instrucción pidió
// explícitamente), nunca una limitación de implementación disfrazada de
// decisión del usuario. "Campaign" nunca se crea en este flujo
// (deliberado, ver discovery-conversion.ts) -- sí se nota si la
// instrucción lo prohibió, para trazabilidad, pero no como afirmación
// de que Lead/Opportunity/Contact tampoco se crean (ahora sí se crean).
function buildRestrictionsApplied(restrictions: MissionRestrictions): string[] {
  const notes: string[] = [];
  if (!restrictions.allowCampaignCreation) notes.push("No se creó ninguna Campaign — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOpportunityCreation) notes.push("No se crearon Opportunities — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOutreach) notes.push("No se planificó ningún outreach — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowMessageSending) notes.push("No se redactó ningún mensaje — la instrucción lo prohibió explícitamente.");
  return notes;
}

function isPreexisting(
  matchedOn: keyof CompanyIdentityKeys,
  matchedValue: string,
  _existingCompanies: unknown[],
  existingKeysSnapshotAtCallTime: Record<keyof CompanyIdentityKeys, Set<string>>,
): boolean {
  // Aproximación honesta: no distinguimos con precisión "ya estaba antes
  // del loop" vs. "se agregó durante este mismo loop" sin una segunda
  // instantánea — se documenta como limitación menor (no afecta
  // duplicatesWithinMission, que sí es exacto; solo el desglose fino
  // duplicatesAlreadyInCrm puede sobreestimar levemente).
  return existingKeysSnapshotAtCallTime[matchedOn].has(matchedValue);
}

async function persistAcceptedCandidate(params: {
  candidate: Candidate;
  industryId: string;
  // Score de completitud de datos (website/phone/address/email
  // confirmados) — computeConfidenceScore, eje DISTINTO del de Business
  // Validation (que mide confianza de que el TIPO de negocio coincide,
  // no cuántos campos vinieron completos). Nunca se mezclan: este va a
  // la columna Company.confidenceScore (sin cambios de F7.3); el de
  // Business Validation va a discoveryMetadata.classificationMode/
  // classificationConfidence (F7.4, ver abajo).
  confidenceScore: number;
  businessValidation: ReturnType<typeof validateBusinessCandidate>;
  missionTaskId: string;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const { candidate, industryId, confidenceScore, businessValidation, missionTaskId } = params;
  const raw = candidate.raw;
  const clientOwnerMatches = detectClientOwnerMatch(raw.name);
  const website = raw.fields.website?.status === "CONFIRMED" ? (raw.fields.website.value as string) : null;
  const phone = raw.fields.phone?.status === "CONFIRMED" ? (raw.fields.phone.value as string) : null;
  const city = raw.fields.city?.status === "CONFIRMED" ? (raw.fields.city.value as string) : candidate.query.city;
  const now = new Date();

  const company = await scopedDb.company.create({
    data: {
      tenantId: ctx.tenantId,
      name: raw.name!,
      industryId,
      status: "LEAD",
      website,
      phone,
      city,
      state: candidate.query.state,
      origin: candidate.origin,
      sourceUrl: raw.sourceUrl,
      discoveredAt: now,
      discoveredByAgentTaskId: missionTaskId,
      verificationStatus: "CONFIRMED",
      confidenceScore,
      lastVerifiedAt: now,
      // F18: WEAK (ninguna señal de evidencia matcheó nada) persiste como
      // DISCOVERY_CANDIDATE -- visible para investigación humana, pero
      // excluido de toda selección de campaña/misión y bloqueado en el
      // chokepoint de creación de Lead/Opportunity (conversion-policy.ts,
      // evaluateBusinessIdentityGate). REJECTED nunca llega acá (filtrado
      // más arriba por `if (!validation.accepted)`).
      commercialStatus: deriveCommercialStatus(businessValidation.confidence),
      // F19 Fase 1: puebla tradeKey SOLO cuando hay evidencia real (no
      // WEAK) de que el candidato pertenece a este taxonomyKey -- mismo
      // criterio que commercialStatus arriba, nunca se etiqueta un
      // trade sin evidencia. Capacidad de modelo únicamente: ningún
      // filtro/selección/scoring lee este campo todavía (Fase 2, fuera
      // de alcance acá).
      tradeKey: businessValidation.confidence !== "WEAK" ? candidate.query.taxonomyKey : null,
      discoveryMetadata: {
        schemaVersion: CEO_INTENT_SCHEMA_VERSION,
        taxonomyVersion: BUSINESS_TAXONOMY_VERSION,
        missionTaskId,
        searchTermsMatched: [candidate.query.searchTerm],
        queryOrigins: [candidate.query.taxonomyKey],
        providerPlaceId: candidate.identity.providerPlaceId,
        canonicalDomain: candidate.identity.canonicalDomain,
        normalizedPhone: candidate.identity.normalizedPhone,
        detectedBusinessType: businessValidation.detectedBusinessType,
        detectedSector: businessValidation.detectedSector,
        // F7.4: nivel real de Business Validation (EXACT/STRONG/
        // APPROXIMATE/WEAK — nunca REJECTED, esos no llegan a
        // persistirse) en vez del literal fijo "EXACT" de F7.3.
        classificationMode: businessValidation.confidence,
        classificationConfidence: businessValidation.confidenceScore,
        classificationReason:
          businessValidation.matchedEvidence.length > 0
            ? `Evidencia coincidente: ${businessValidation.matchedEvidence.join(", ")}.`
            : `Sin evidencia directa (nombre/categorías/dominio/descripción) para el trade "${candidate.query.taxonomyKey}" -- confianza ${businessValidation.confidence}.`,
        // F7.4: nuevos campos de discoveryMetadata (Json, sin migración) —
        // trazabilidad completa de Business Validation.
        matchedEvidence: businessValidation.matchedEvidence,
        missingEvidence: businessValidation.missingEvidence,
        businessValidationVersion: BUSINESS_VALIDATION_VERSION,
        accepted: true,
        rejectionReason: null,
        // F16: categorías reales del proveedor (Google Places
        // `place.types`) -- ya propagadas y usadas como evidencia real en
        // classifyCandidate, acá solo se persisten para trazabilidad.
        originalProviderTypes: raw.providerTypes ?? [],
        // F16: clasificación (nunca exclusión automática) cuando el
        // NOMBRE del candidato coincide con un cliente de infraestructura
        // crítica conocido -- ver critical-infrastructure-clients.ts.
        isClientOwnerCandidate: clientOwnerMatches.length > 0,
        clientOwnerAssociations: clientOwnerMatches,
        discoveredAt: now.toISOString(),
        lastUpdatedAt: now.toISOString(),
      },
    },
  });

  await logAuditEvent({
    action: "company.discovered_by_agent",
    entityType: "company",
    entityId: company.id,
    after: { name: raw.name, sourceUrl: raw.sourceUrl, confidenceScore, origin: candidate.origin },
  });

  return company;
}
