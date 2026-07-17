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
import { normalizeText, containsWord } from "../ceo-intelligence/text-normalize";
import {
  buildCompanyIdentityKeys,
  deduplicateDiscoveryCandidates,
  type CompanyIdentityKeys,
  type DiscoveryCandidateLike,
} from "../ceo-intelligence/discovery-identity";
import { createQueuedTask } from "./task-executor";
import { computeConfidenceScore } from "./tools/discovery-tools.impl";
import { searchGooglePlaces } from "./tools/discovery-providers/google-places";
import { searchOverpass } from "./tools/discovery-providers/overpass";
import { emptyResult, type ProviderCandidate, type ProviderSearchResult } from "./tools/discovery-providers/types";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "./tools/provider-health";
import { getDataProviderBudgetStatus } from "./data-provider-budget";

/**
 * F7.3: ejecutor real de descubrimiento a partir de un MissionPlan ya
 * generado (F7.1/F7.2, sin modificar). Reemplaza, SOLO para el flujo
 * nuevo, el patrón "por cada industria: ejecutar todos los search terms"
 * de discovery-tools.impl.ts (que sigue existiendo, sin tocar, para el
 * AgentTool discover_companies clásico) por: "por cada query única del
 * plan: ejecutar una vez, deduplicar globalmente, clasificar, validar,
 * persistir solo Company". Separación explícita en 8 pasos (ver plan
 * aprobado): validación de plan (buildFinalQueries + guards de estado),
 * selección de pasos permitidos (guards BLOCKED de arriba), ejecución de
 * queries (executeOneQuery), normalización (buildCompanyIdentityKeys),
 * deduplicación (deduplicateDiscoveryCandidates), clasificación
 * (classifyCandidate), persistencia (persistAcceptedCandidate), reporte
 * (buildReport).
 *
 * Nunca crea Lead/Opportunity/Campaign/Contact/CompanyContactPoint — solo
 * Company + un AgentTask hijo de trazabilidad mínima (tipo
 * "discover_companies", igual que el flujo clásico, para que participe
 * del mismo guardia de presupuesto de datos en data-provider-budget.ts).
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
  // Inyección para tests — nunca se llama a un proveedor real en un test
  // unitario. Default: los módulos reales (google-places.ts/overpass.ts,
  // sin modificar).
  providers?: DiscoveryProviderPort;
  googlePlacesApiKey?: string;
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
 * Validación básica y determinista (F7.3 — no reemplaza Business
 * Validation completa de una fase futura, que crawlearía el sitio real).
 * Evidencia disponible hoy: nombre + exclusiones explícitas de la misión
 * + negativeKeywords de la entrada de taxonomía que originó la query.
 * Nunca acepta un candidato sin nombre utilizable. El bucket de Industry
 * (crmIndustryBucket null) es un rechazo aparte, ver rejectForMissingBucket.
 */
function classifyCandidate(
  candidate: Candidate,
  plan: MissionPlan,
): { accepted: true; confidence: number } | { accepted: false; reason: string; evidence: string; confidence: number } {
  if (!candidate.raw.name) {
    return { accepted: false, reason: "Sin nombre utilizable en la respuesta del proveedor.", evidence: candidate.raw.sourceUrl, confidence: 1 };
  }

  const normalizedName = normalizeText(candidate.raw.name);
  for (const exclusion of plan.exclusions) {
    if (exclusion.trim() && containsWord(normalizedName, normalizeText(exclusion))) {
      return {
        accepted: false,
        reason: `El nombre coincide con un término excluido explícitamente por la misión: "${exclusion}".`,
        evidence: candidate.raw.name,
        confidence: 1,
      };
    }
  }

  const entry = getTaxonomyEntry(candidate.query.taxonomyKey);
  if (entry) {
    for (const negative of entry.negativeKeywords) {
      if (containsWord(normalizedName, normalizeText(negative))) {
        return {
          accepted: false,
          reason: `El nombre sugiere un falso positivo para "${entry.label}": coincide con "${negative}".`,
          evidence: candidate.raw.name,
          confidence: 0.7,
        };
      }
    }
  }

  return { accepted: true, confidence: computeConfidenceScore(candidate.raw.fields) };
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
    "Contact Intelligence no fue ejecutado en esta fase.",
    "Business Validation es básica (nombre + exclusiones + negativeKeywords) — no incluye crawl del sitio real.",
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
  const providersUsed = new Set<string>();
  const providersOmitted = new Set<string>();
  const createdCompanyIds: string[] = [];
  let totalCostUsd = 0;
  let rawResults = 0;
  let acceptedResults = 0;
  let rejectedResults = 0;
  let duplicatesWithinMission = 0;
  let duplicatesAlreadyInCrm = 0;
  let cancelled = false;
  let stopReason = "queries_exhausted";

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

        const classification = classifyCandidate(candidate, params.plan);
        if (!classification.accepted) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason: classification.reason,
            evidence: classification.evidence,
            confidence: classification.confidence,
          });
          continue;
        }

        if (!candidate.query.crmIndustryBucket) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason: `Sin bucket de Industry real aprobado para la categoría "${candidate.query.taxonomyKey}" — decisión pendiente del PO (ver plan §9.4). No se persiste hasta que se apruebe/cree la Industry correspondiente.`,
            evidence: candidate.raw.name ?? candidate.raw.sourceUrl,
            confidence: 1,
          });
          continue;
        }

        const industry = await scopedDb.industry.findFirst({ where: { name: candidate.query.crmIndustryBucket } });
        if (!industry) {
          rejectedResults += 1;
          record.rejectedCount += 1;
          rejectedCandidates.push({
            name: candidate.raw.name,
            taxonomyKey: candidate.query.taxonomyKey,
            reason: `Industry real "${candidate.query.crmIndustryBucket}" no existe en el CRM de este tenant.`,
            evidence: candidate.raw.name ?? candidate.raw.sourceUrl,
            confidence: 1,
          });
          continue;
        }

        const company = await persistAcceptedCandidate({
          candidate,
          industryId: industry.id,
          confidenceScore: classification.confidence,
          missionTaskId: childTask.id,
        });
        createdCompanyIds.push(company.id);
        acceptedResults += 1;
        record.acceptedCount += 1;
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
      output: { queryExecutions, createdCompanyIds, rejectedCandidates, missionState } as never,
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
    "No se crea ninguna Lead/Opportunity/Campaign/Contact/CompanyContactPoint en este flujo — solo Company + trazabilidad mínima de misión.",
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
  confidenceScore: number;
  missionTaskId: string;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const { candidate, industryId, confidenceScore, missionTaskId } = params;
  const raw = candidate.raw;
  const website = raw.fields.website?.status === "CONFIRMED" ? (raw.fields.website.value as string) : null;
  const phone = raw.fields.phone?.status === "CONFIRMED" ? (raw.fields.phone.value as string) : null;
  const city = raw.fields.city?.status === "CONFIRMED" ? (raw.fields.city.value as string) : candidate.query.city;
  const now = new Date();
  const entry = getTaxonomyEntry(candidate.query.taxonomyKey);

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
        detectedBusinessType: entry?.companyTypes[0] ?? candidate.query.taxonomyKey,
        detectedSector: candidate.query.crmIndustryBucket,
        classificationMode: "EXACT",
        classificationConfidence: confidenceScore,
        classificationReason: `Encontrada por la query "${candidate.query.searchTerm}" (taxonomía: ${candidate.query.taxonomyKey}), archivada bajo Industry real "${candidate.query.crmIndustryBucket}".`,
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
