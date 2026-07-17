import { z } from "zod";
import { agentTaskListItemSchema } from "./agents";
import { companyOriginSchema, companyVerificationStatusSchema, contactVerificationStatusSchema } from "./crm";

// ============================================================
// F4: Daily Revenue Mission — ver F4_AUTONOMOUS_OUTREACH_PLAN.md,
// addendum "Daily Revenue Mission y camino hacia autonomía externa".
// NO tiene modelo propio: es un AgentTask raíz (type:
// "daily_revenue_mission") con parentTaskId plano hacia sus tareas
// delegadas. Objetivo/filtros viven en AgentTask.input; progreso/reporte
// viven en AgentTask.output — estos schemas describen esa forma para la
// API, no una tabla nueva.
// ============================================================

// Corrección estructural (misión Iowa, 2026-07-13): espejo de
// packages/agents/src/tools/mission-restrictions.ts — packages/shared no
// puede importar de packages/agents (dependencia va al revés, ver
// package.json), así que este shape simple (4 booleanos) se duplica acá
// a propósito, mismo criterio ya usado para otros enums espejados entre
// capas en este proyecto.
export const missionRestrictionsSchema = z.object({
  allowCampaignCreation: z.boolean(),
  allowOpportunityCreation: z.boolean(),
  allowOutreach: z.boolean(),
  allowMessageSending: z.boolean(),
});
export type MissionRestrictions = z.infer<typeof missionRestrictionsSchema>;

export const businessObjectiveTypeSchema = z.enum([
  "meetings",
  "new_clients",
  "companies_found",
  "pipeline_increase",
  "custom",
]);

export const businessObjectiveSchema = z.object({
  type: businessObjectiveTypeSchema,
  target: z.number().positive().nullable(),
  unit: z.string(),
  rawText: z.string(),
});
export type BusinessObjective = z.infer<typeof businessObjectiveSchema>;

export const objectiveProgressSchema = z.object({
  type: businessObjectiveTypeSchema,
  target: z.number().nullable(),
  unit: z.string(),
  current: z.number(),
  percentComplete: z.number().nullable(),
  rawText: z.string(),
});
export type ObjectiveProgress = z.infer<typeof objectiveProgressSchema>;

// "RUNNING"/"DONE"/"FAILED" son el AgentTask.status real (enum ya
// existente); los sub-estados de PAUSED_*/CANCELLED/COMPLETED/FAILED/
// PARTIAL viven dentro de output.missionState (Json), no en una columna
// nueva — ver la decisión explícita en el addendum de no ensanchar
// AgentTaskStatus. FAILED (bugfix de ciclo de vida): una misión que se
// cae por una excepción real, un timeout global, o el watchdog de
// inactividad, transiciona acá — nunca se queda en RUNNING para siempre.
// PARTIAL (corrección estructural, misión Iowa 2026-07-13): el pipeline
// corrió de punta a punta sin excepciones, pero no logró lo que la
// instrucción pedía (ej. "buscá contactos" y quedaron empresas sin
// ningún punto de contacto, real o organizacional) — antes esto se
// reportaba como COMPLETED sin ninguna distinción, presentando un
// resultado incompleto como si fuera un éxito total. Ver
// contactCoverage en missionDetailSchema para el detalle honesto de qué
// faltó y por qué.
// F7.2: "PLANNED" -- una misión que solo interpretó y planificó (F7.1's
// interpretBusinessIntent + buildMissionPlan), sin ejecutar ninguna
// herramienta externa todavía. Extensión segura de este enum (vive
// dentro de AgentTask.output, un campo Json -- nunca un enum real de
// Postgres) -- cero migración, cero cambio de AgentTaskStatus (ese sigue
// siendo "DONE", ver missionPhaseSchema abajo para la señal explícita
// adicional que lo distingue de una ejecución real terminada).
// F7.3: "NO_RESULTS" -- el ejecutor de descubrimiento corrió las queries
// planificadas correctamente (sin error técnico bloqueante) pero cero
// candidatos pasaron validación/dedup -- nunca se reporta como COMPLETED
// con 0 empresas. "BLOCKED" -- no había ninguna capacidad real disponible
// ANTES de arrancar (sin estado soportado, sin queries, sin ningún
// proveedor con cobertura) -- ver mission-executor.ts.
export const missionStateSchema = z.enum([
  "RUNNING",
  "PAUSED_BY_USER",
  "PAUSED_BUDGET",
  "CANCELLED",
  "COMPLETED",
  "PARTIAL",
  "NO_RESULTS",
  "BLOCKED",
  "FAILED",
  "PLANNED",
]);
export type MissionState = z.infer<typeof missionStateSchema>;

// F7.2: señal explícita y redundante a propósito -- "PLANNED" en
// missionState ya lo dice, pero AgentTask.status sigue siendo "DONE"
// (no existe un valor "PLANNED" en ese enum real y no se cambia sin
// aprobación), así que missionPhase existe para que ninguna lectura de
// la UI/API tenga que inferirlo indirectamente. "EXECUTING" es el
// default implícito de toda misión real (F4/F4.5A) — nunca se escribe
// para esas, missionPhase queda null/ausente y se interpreta como
// "EXECUTING" por compatibilidad con misiones ya existentes.
export const missionPhaseSchema = z.enum(["PLANNED", "EXECUTING"]);
export type MissionPhase = z.infer<typeof missionPhaseSchema>;

export const launchMissionInputSchema = z.object({
  instruction: z.string().min(1).max(2000),
});
export type LaunchMissionInput = z.infer<typeof launchMissionInputSchema>;

// "recover" (bugfix de ciclo de vida): herramienta administrativa para
// una misión atascada en RUNNING sin actividad — fuerza la transición a
// FAILED sin depender de ninguna llamada externa (ni siquiera al LLM del
// Executive Report), justamente porque el objetivo es recuperar un caso
// donde algo externo ya no responde.
export const missionActionInputSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "close_now", "recover"]),
});
export type MissionActionInput = z.infer<typeof missionActionInputSchema>;

// ============================================================
// F7.2: CEO Intelligence — espejo de contratos de
// apps/api/src/modules/ceo-intelligence/contracts.ts. packages/shared
// no puede importar de apps/api (ni de packages/agents, ver
// missionRestrictionsSchema arriba) — mismo criterio de "duplicar la
// forma, no la dependencia" ya establecido en este archivo. La fuente
// de verdad determinista del intérprete/planner/taxonomía sigue
// viviendo exclusivamente en apps/api/src/modules/ceo-intelligence/
// (F7.1, sin tocar en F7.2).
// ============================================================

export const CEO_INTENT_SCHEMA_VERSION = 1;
export const BUSINESS_TAXONOMY_VERSION = 1;
export const MISSION_PLANNER_VERSION = 1;

export const ceoMissionObjectiveTypeSchema = z.enum([
  "find_companies",
  "find_contacts",
  "find_hiring_signals",
  "custom",
]);
export type CeoMissionObjectiveType = z.infer<typeof ceoMissionObjectiveTypeSchema>;

export const ceoMissionObjectiveSchema = z.object({
  type: ceoMissionObjectiveTypeSchema,
  targetCompanyCount: z.number().int().positive().nullable(),
  rawText: z.string(),
});
export type CeoMissionObjective = z.infer<typeof ceoMissionObjectiveSchema>;

export const ceoMissionPlanStepSchema = z.enum([
  "discover_companies",
  "validate_business_type",
  "find_hiring_signals",
  "find_contacts",
  "find_organizational_emails",
  "verify_emails",
]);
export type CeoMissionPlanStep = z.infer<typeof ceoMissionPlanStepSchema>;

export const ceoStructuredIntentSchema = z.object({
  schemaVersion: z.literal(1),
  rawInstruction: z.string(),
  objective: ceoMissionObjectiveSchema,
  companyTypes: z.array(z.string()),
  industries: z.array(z.string()),
  businessActivities: z.array(z.string()),
  searchTerms: z.array(z.string()),
  hiringSignals: z.array(z.string()),
  decisionRoles: z.array(z.string()),
  targetJobTitles: z.array(z.string()),
  exclusions: z.array(z.string()),
  preferredCities: z.array(z.string()),
  states: z.array(z.string()),
  providersRequested: z.array(z.string()),
  restrictions: missionRestrictionsSchema,
  plannedSteps: z.array(ceoMissionPlanStepSchema),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string()),
  unsupportedCapabilities: z.array(z.string()),
  matchedTaxonomyKeys: z.array(z.string()),
});
export type CeoStructuredIntent = z.infer<typeof ceoStructuredIntentSchema>;

export const ceoMissionPlanSearchQuerySchema = z.object({
  searchTerm: z.string(),
  crmIndustryBucket: z.string().nullable(),
  taxonomyKey: z.string(),
});
export type CeoMissionPlanSearchQuery = z.infer<typeof ceoMissionPlanSearchQuerySchema>;

export const ceoMissionPlanStopConditionsSchema = z.object({
  maxCompanies: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  maxDurationMinutes: z.number().positive(),
});
export type CeoMissionPlanStopConditions = z.infer<typeof ceoMissionPlanStopConditionsSchema>;

export const ceoMissionPlanFallbackSchema = z.object({
  provider: z.string(),
  whenUnavailable: z.string(),
});
export type CeoMissionPlanFallback = z.infer<typeof ceoMissionPlanFallbackSchema>;

export const ceoDedupStrategyKeySchema = z.enum([
  "providerPlaceId",
  "canonicalDomain",
  "normalizedPhone",
  "normalizedNameCityState",
]);
export type CeoDedupStrategyKey = z.infer<typeof ceoDedupStrategyKeySchema>;

export const ceoMissionPlanSchema = z.object({
  schemaVersion: z.literal(1),
  objective: ceoMissionObjectiveSchema,
  searchQueries: z.array(ceoMissionPlanSearchQuerySchema),
  exclusions: z.array(z.string()),
  cities: z.array(z.string()),
  states: z.array(z.string()),
  steps: z.array(ceoMissionPlanStepSchema),
  requiredSteps: z.array(ceoMissionPlanStepSchema),
  optionalSteps: z.array(ceoMissionPlanStepSchema),
  stopConditions: ceoMissionPlanStopConditionsSchema,
  dedupStrategy: z.array(ceoDedupStrategyKeySchema),
  fallbackStrategy: z.array(ceoMissionPlanFallbackSchema),
  restrictions: missionRestrictionsSchema,
  rationale: z.string(),
});
export type CeoMissionPlan = z.infer<typeof ceoMissionPlanSchema>;

// Metadata de versionado persistida junto al intent/plan — nunca se
// mezcla con MATCH_SCHEMA_VERSION/MATCH_ALGORITHM_VERSION (F6), cada
// integración versiona la suya (ver docs/F7_CEO_INTELLIGENCE_AND_
// AUTONOMOUS_CLIENT_ACQUISITION_PLAN.md, sección de versionado).
export const ceoIntentMetaSchema = z.object({
  schemaVersion: z.literal(CEO_INTENT_SCHEMA_VERSION),
  taxonomyVersion: z.literal(BUSINESS_TAXONOMY_VERSION),
  plannerVersion: z.literal(MISSION_PLANNER_VERSION),
  createdAt: z.string(),
  warnings: z.array(z.string()),
});
export type CeoIntentMeta = z.infer<typeof ceoIntentMetaSchema>;

export const missionListItemSchema = z.object({
  id: z.string(),
  rawInstruction: z.string(),
  industryNames: z.array(z.string()),
  state: z.string().nullable(),
  city: z.string().nullable(),
  categoryNames: z.array(z.string()),
  desiredVolume: z.number().nullable(),
  businessObjective: businessObjectiveSchema,
  missionState: missionStateSchema,
  companiesTargeted: z.number(),
  leadsCreated: z.number(),
  opportunitiesCreated: z.number(),
  sequencesPlanned: z.number(),
  draftsAwaitingApproval: z.number(),
  costUsdSoFar: z.number(),
  objectiveProgress: objectiveProgressSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  // bugfix de ciclo de vida: heartbeat — se actualiza en cada paso real
  // del pipeline; el watchdog del scheduler compara esto contra "ahora"
  // para distinguir una misión activa de una atascada sin inventar un
  // plazo fijo basado en el día calendario.
  progressUpdatedAt: z.string().nullable(),
  // bugfix de ciclo de vida: mensaje de error real cuando missionState
  // es FAILED — nunca null en ese caso, siempre explica qué pasó.
  error: z.string().nullable(),
  // Corrección estructural (misión Iowa, 2026-07-13): qué restricciones
  // pidió la instrucción y qué se saltó por eso — nunca silencioso. null
  // en misiones lanzadas antes de este fix (no tenían este campo).
  appliedRestrictions: missionRestrictionsSchema.nullable(),
  restrictionNotes: z.array(z.string()),
  // F7.2: null en toda misión lanzada antes de este fix (ejecución real
  // directa, sin fase de planificación separada) — se interpreta como
  // "EXECUTING" por compatibilidad, nunca se hace backfill retroactivo.
  missionPhase: missionPhaseSchema.nullable(),
});
export type MissionListItem = z.infer<typeof missionListItemSchema>;

// F4.5: transparencia — empresa seleccionada por la misión, con su
// procedencia y fuente, para que nunca haya duda de dónde salió cada una.
// F4.5A agrega website/phone/email/confidence/verification — mismos datos
// que Company ya tiene, mostrados acá para no obligar a abrir cada
// registro para ver qué encontró el Discovery Agent.
export const missionCompanySchema = z.object({
  companyId: z.string(),
  companyName: z.string(),
  industryName: z.string(),
  origin: companyOriginSchema,
  sourceUrl: z.string().nullable(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  confidenceScore: z.number().nullable(),
  verificationStatus: companyVerificationStatusSchema,
});
export type MissionCompany = z.infer<typeof missionCompanySchema>;

// F4.6: contacto encontrado por el Contact Intelligence Agent para una
// empresa que ESTA misión descubrió — mismo principio de transparencia.
export const missionContactSchema = z.object({
  contactId: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  source: z.string().nullable(),
  confidenceScore: z.number().nullable(),
  verificationStatus: contactVerificationStatusSchema,
  discoveredAt: z.string().nullable(),
});
export type MissionContact = z.infer<typeof missionContactSchema>;

// F4.6: cadena de métricas de Mission Detail — "Empresas descubiertas →
// Contactos encontrados → Contactos verificados → Emails encontrados →
// LinkedIn encontrados → Costo → Tiempo", todo real, agregado de las
// tareas find_contacts que esta misión delegó.
export const missionContactStatsSchema = z.object({
  companiesDiscovered: z.number(),
  contactsFound: z.number(),
  contactsVerified: z.number(),
  emailsFound: z.number(),
  linkedinFound: z.number(),
  costUsd: z.number(),
  durationMs: z.number().nullable(), // null si no hubo ninguna tarea find_contacts todavía
});
export type MissionContactStats = z.infer<typeof missionContactStatsSchema>;

// Corrección estructural (misión Iowa, 2026-07-13): antes, "0 contactos"
// no se distinguía de "no se buscaron contactos" ni de "el proveedor no
// pudo responder" — esto lo hace explícito. companiesWithContactPoint
// cuenta tanto Contact nombrados como Company.email organizacional
// (ver §6 del pedido: un email genérico real sin persona identificada
// también cuenta como punto de contacto).
export const missionContactCoverageSchema = z.object({
  companiesConsidered: z.number(),
  companiesWithContactPoint: z.number(),
  companiesWithoutContactPoint: z.number(),
  providersOmitted: z.array(z.string()),
});
export type MissionContactCoverage = z.infer<typeof missionContactCoverageSchema>;

// ============================================================
// F7.3: Dynamic Mission Orchestration — espejo de las shapes de
// apps/api/src/modules/agents/mission-executor.ts (mismo criterio de
// "duplicar la forma, no la dependencia" que el resto de este archivo).
// Solo presente en misiones que pasaron por el nuevo ejecutor
// (mission-orchestrator.ts's runDynamicDiscoveryMission) — null en
// cualquier misión legacy, planned-only (F7.2), o interna sin
// descubrimiento externo.
// ============================================================

export const discoveryQueryExecutionSchema = z.object({
  query: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  taxonomyKey: z.string(),
  crmIndustryBucket: z.string().nullable(),
  origin: z.enum(["API_PROVIDER", "EXTERNAL_DISCOVERY"]).nullable(),
  provider: z.string().nullable(),
  executedAt: z.string(),
  rawResultCount: z.number(),
  acceptedCount: z.number(),
  rejectedCount: z.number(),
  duplicateCount: z.number(),
  error: z.string().nullable(),
});
export type DiscoveryQueryExecution = z.infer<typeof discoveryQueryExecutionSchema>;

export const discoveryRejectedCandidateSchema = z.object({
  name: z.string().nullable(),
  taxonomyKey: z.string(),
  reason: z.string(),
  evidence: z.string(),
  confidence: z.number(),
  // F7.4: presentes solo cuando el rechazo vino de Business Validation.
  matchedEvidence: z.array(z.string()).optional(),
  missingEvidence: z.array(z.string()).optional(),
});
export type DiscoveryRejectedCandidate = z.infer<typeof discoveryRejectedCandidateSchema>;

// F7.4 Parte A: nivel de confianza real de Business Validation — nunca
// "REJECTED" en un registro persistido (esos candidatos no llegan a
// crear Company, ver mission-executor.ts's classifyCandidate).
export const businessValidationConfidenceLevelSchema = z.enum(["EXACT", "STRONG", "APPROXIMATE", "WEAK", "REJECTED"]);
export type BusinessValidationConfidenceLevel = z.infer<typeof businessValidationConfidenceLevelSchema>;

// F7.5: estados lógicos de Hiring Signal Intelligence — espejo de
// HiringStatus (apps/api/.../ceo-intelligence/hiring-signals.ts).
export const hiringStatusSchema = z.enum([
  "CONFIRMED_HIRING",
  "LIKELY_HIRING",
  "POSSIBLE_HIRING",
  "NO_SIGNAL",
  "BLOCKED",
  "UNKNOWN",
]);
export type HiringStatus = z.infer<typeof hiringStatusSchema>;

// F7.4 Parte A + B / F7.5: un registro por Company realmente persistida —
// espejo de CompanyValidationRecord (apps/api/.../mission-executor.ts).
export const companyValidationRecordSchema = z.object({
  companyId: z.string(),
  name: z.string(),
  taxonomyKey: z.string(),
  businessConfidence: businessValidationConfidenceLevelSchema,
  detectedBusinessType: z.string().nullable(),
  detectedSector: z.string().nullable(),
  matchedEvidence: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  emailsExtracted: z.number(),
  emailsVerified: z.number(),
  emailsRisky: z.number(),
  emailsInvalid: z.number(),
  companyContactPointsCreated: z.number(),
  hasValidEmail: z.boolean(),
  // F7.5: null cuando el plan no declaró find_hiring_signals.
  hiringStatus: hiringStatusSchema.nullable(),
  hiringConfidence: z.number().nullable(),
  targetTitlesMatched: z.array(z.string()),
  // F7.6: null cuando el plan no declaró find_contacts -- espejo de
  // DecisionRolePlan (apps/api/.../ceo-intelligence/role-planning.ts).
  rolePlan: z
    .object({
      companyId: z.string(),
      targetRoles: z.array(
        z.object({
          role: z.string(),
          priority: z.number(),
          rationale: z.string(),
          source: z.enum(["intent", "taxonomy", "hiring_signal_boost"]),
        }),
      ),
      excludedRoles: z.array(z.string()),
      confidence: z.number(),
      taxonomySource: z.string(),
      hiringSignalSource: z.string().nullable(),
      planVersion: z.number(),
    })
    .nullable(),
});
export type CompanyValidationRecord = z.infer<typeof companyValidationRecordSchema>;

export const discoveryExecutionReportSchema = z.object({
  requestedCompanyCount: z.number(),
  queriesPlanned: z.number(),
  queriesExecuted: z.number(),
  rawResults: z.number(),
  acceptedResults: z.number(),
  rejectedResults: z.number(),
  duplicatesWithinMission: z.number(),
  duplicatesAlreadyInCrm: z.number(),
  companiesCreated: z.number(),
  createdCompanyIds: z.array(z.string()),
  providersUsed: z.array(z.string()),
  providersOmitted: z.array(z.string()),
  // F7.4 Parte A: alias explícitos pedidos por el PO — mismos números
  // que acceptedResults/rejectedResults/su suma, nunca recalculados.
  candidatesValidated: z.number(),
  acceptedCompanies: z.number(),
  rejectedCompanies: z.number(),
  rejectionReasons: z.array(z.string()),
  // F7.4 Parte B: agregados de Email Trust sobre toda la misión.
  emailsExtracted: z.number(),
  emailsVerified: z.number(),
  emailsRisky: z.number(),
  emailsInvalid: z.number(),
  emailsUnknown: z.number(),
  companyContactPointsCreated: z.number(),
  companiesWithoutValidEmail: z.number(),
  validationWarnings: z.array(z.string()),
  companyValidations: z.array(companyValidationRecordSchema),
  // F7.5: agregados de Hiring Signal Intelligence.
  hiringSignalsChecked: z.number(),
  companiesConfirmedHiring: z.number(),
  companiesLikelyHiring: z.number(),
  companiesPossibleHiring: z.number(),
  companiesNoHiringSignal: z.number(),
  // F7.6: cuántas Companies recibieron un Decision-Maker Role Plan.
  rolePlansBuilt: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  stopReason: z.string(),
  limitations: z.array(z.string()),
  missionState: missionStateSchema,
  restrictionsApplied: z.array(z.string()),
  queryExecutions: z.array(discoveryQueryExecutionSchema),
  rejectedCandidates: z.array(discoveryRejectedCandidateSchema),
});
export type DiscoveryExecutionReport = z.infer<typeof discoveryExecutionReportSchema>;

export const missionDetailSchema = missionListItemSchema.extend({
  unrecognizedTerms: z.array(z.string()),
  report: z.string().nullable(), // Executive Report — null mientras RUNNING/PAUSED_*
  childTasks: z.array(agentTaskListItemSchema),
  selectedCompanies: z.array(missionCompanySchema),
  contacts: z.array(missionContactSchema),
  contactStats: missionContactStatsSchema,
  contactCoverage: missionContactCoverageSchema.nullable(),
  // F7.2: interpretación + plan del CEO Intelligence — null en toda
  // misión que no pasó por la fase de planificación nueva (todas las
  // anteriores a F7.2, y cualquier misión lanzada por el flujo real
  // viejo de interpretDailyDirective, que sigue coexistiendo).
  ceoIntent: ceoStructuredIntentSchema.nullable(),
  missionPlan: ceoMissionPlanSchema.nullable(),
  ceoIntentMeta: ceoIntentMetaSchema.nullable(),
  // F7.3: reporte del ejecutor dinámico de descubrimiento — null salvo en
  // misiones que realmente ejecutaron discover_companies vía el nuevo
  // ejecutor (mission-executor.ts). "Contact Intelligence no fue
  // ejecutado en esta fase" se infiere de este reporte existiendo y
  // contacts/contactStats quedando vacíos — nunca se muestra "0 emails"
  // como si Contact Intelligence hubiera corrido.
  discoveryExecution: discoveryExecutionReportSchema.nullable(),
});
export type MissionDetail = z.infer<typeof missionDetailSchema>;
