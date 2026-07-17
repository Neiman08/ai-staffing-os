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
import { SUPPORTED_STATE_CODES } from "../ceo-intelligence/geo";
import { normalizeText } from "../ceo-intelligence/text-normalize";
import {
  buildCompanyIdentityKeys,
  deduplicateDiscoveryCandidates,
  type CompanyIdentityKeys,
  type DiscoveryCandidateLike,
} from "../ceo-intelligence/discovery-identity";
import { validateBusinessCandidate, BUSINESS_VALIDATION_VERSION, type BusinessValidationConfidenceLevel } from "../ceo-intelligence/business-validation";
import { createQueuedTask } from "./task-executor";
import { computeConfidenceScore } from "./tools/discovery-tools.impl";
import { searchGooglePlaces } from "./tools/discovery-providers/google-places";
import { searchOverpass } from "./tools/discovery-providers/overpass";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "./tools/provider-health";
import { getDataProviderBudgetStatus } from "./data-provider-budget";
import { enrichCompanyWithOrganizationalEmails, type WebsiteIntelligencePort } from "./company-enrichment";
import { evaluateHiringSignals, type HiringSignalResult } from "../ceo-intelligence/hiring-signals";

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
 * Nunca crea Lead/Opportunity/Campaign/Contact — solo Company,
 * CompanyContactPoint (únicamente emails VERIFIED/RISKY, nunca INVALID)
 * y un AgentTask hijo de trazabilidad mínima (tipo "discover_companies",
 * igual que el flujo clásico, para que participe del mismo guardia de
 * presupuesto de datos en data-provider-budget.ts). Contact Intelligence
 * (contactos personales nombrados) sigue sin ejecutarse en esta fase.
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
  // Inyección para tests — nunca se llama a un proveedor real en un test
  // unitario. Default: los módulos reales (google-places.ts/overpass.ts,
  // sin modificar).
  providers?: DiscoveryProviderPort;
  googlePlacesApiKey?: string;
  // F7.4: inyección para tests de Website Intelligence (company-enrichment.ts)
  // — nunca se llama al crawler real en un test unitario. Default: el
  // módulo real.
  websiteIntelligence?: WebsiteIntelligencePort;
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
}

interface FinalQuery {
  searchTerm: string;
  city: string | null;
  state: string;
  taxonomyKey: string;
  crmIndustryBucket: string | null;
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
export function buildFinalQueries(plan: MissionPlan, primaryState: string): FinalQuery[] {
  const cities = plan.cities.length > 0 ? plan.cities : [null];
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
      });
    }
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
 * F7.4 Parte A: adaptador delgado sobre validateBusinessCandidate
 * (business-validation.ts, puro) — reemplaza la validación básica de
 * F7.3 (solo nombre + exclusiones + negativeKeywords) por el evaluador
 * completo taxonomy-driven (nombre + dominio + descripción + provider
 * types + businessActivities, 5 niveles de confianza EXACT/STRONG/
 * APPROXIMATE/WEAK/REJECTED). `providerTypes`/`description` quedan
 * siempre vacíos hoy -- ningún proveedor conectado los popula todavía
 * (limitación documentada, ver discoveryMetadata.originalProviderTypes,
 * F7.3 §15.11 y F7.4 doc).
 */
function classifyCandidate(candidate: Candidate, plan: MissionPlan, businessActivities: string[]) {
  const website = candidate.raw.fields.website?.status === "CONFIRMED" ? (candidate.raw.fields.website.value as string) : null;
  return validateBusinessCandidate({
    candidateName: candidate.raw.name,
    website,
    searchTerm: candidate.query.searchTerm,
    taxonomyKey: candidate.query.taxonomyKey,
    city: candidate.query.city,
    state: candidate.query.state,
    missionExclusions: plan.exclusions,
    providerTypes: [],
    description: null,
    businessActivities,
  });
}

/**
 * Ejecuta el paso discover_companies de un MissionPlan ya validado —
 * único punto de entrada real que llama a los proveedores externos
 * (Google Places/Overpass). Nunca crea Lead/Opportunity/Campaign/Contact/
 * CompanyContactPoint — solo Company + un AgentTask hijo mínimo
 * (type: "discover_companies", igual nombre que el flujo clásico para
 * compartir el mismo guardia de presupuesto de datos).
 */
export async function executeDiscoveryPlan(params: ExecuteDiscoveryPlanParams): Promise<DiscoveryExecutionReport> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const startedAt = Date.now();
  const providers = params.providers ?? REAL_PROVIDERS;
  const googlePlacesApiKey = params.googlePlacesApiKey ?? env.GOOGLE_PLACES_API_KEY;
  const requestedCompanyCount = params.plan.stopConditions.maxCompanies;
  const limitations: string[] = [
    "Contact Intelligence (contactos personales) no fue ejecutado en esta fase.",
    "Business Validation no incluye provider types ni descripción pública — ningún proveedor conectado los popula todavía (evidencia limitada a nombre/dominio/query).",
  ];

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

  const finalQueries = buildFinalQueries(params.plan, primaryState);
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
          state: query.state,
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

        // F7.5: Hiring Signal Intelligence — paso opcional del plan
        // (find_hiring_signals), nunca corre si el plan no lo declaró.
        // Reutiliza EXACTAMENTE el mismo crawl que ya hizo el
        // enriquecimiento de emails (enrichment.websiteSignals) — jamás
        // un segundo request al mismo sitio.
        let hiringSignal: HiringSignalResult | null = null;
        if (params.plan.steps.includes("find_hiring_signals")) {
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
          // `company.discoveryMetadata` ya trae el objeto que
          // persistAcceptedCandidate acaba de escribir (Prisma devuelve
          // la fila creada) -- se extiende in-memory, sin un fetch extra.
          await scopedDb.company.update({
            where: { id: company.id },
            data: { discoveryMetadata: { ...(company.discoveryMetadata as object), hiringSignal } as never },
          });
        }

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
        });
      }
    }

    queryExecutions.push(record);
    if (cancelled) break outer;
  }

  if (createdCompanyIds.length >= requestedCompanyCount) stopReason = "limit_reached";

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

function buildRestrictionsApplied(restrictions: MissionRestrictions): string[] {
  const notes: string[] = [
    "No se crea ninguna Lead/Opportunity/Campaign/Contact en este flujo — solo Company, CompanyContactPoint (emails organizacionales verificados) y trazabilidad mínima de misión.",
  ];
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
            : `Sin evidencia directa en nombre/dominio — aceptada por confianza ${businessValidation.confidence} (query dirigida de la taxonomía "${candidate.query.taxonomyKey}").`,
        // F7.4: nuevos campos de discoveryMetadata (Json, sin migración) —
        // trazabilidad completa de Business Validation.
        matchedEvidence: businessValidation.matchedEvidence,
        missingEvidence: businessValidation.missingEvidence,
        businessValidationVersion: BUSINESS_VALIDATION_VERSION,
        accepted: true,
        rejectionReason: null,
        originalProviderTypes: [],
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
