import {
  CEO_INTENT_SCHEMA_VERSION,
  BUSINESS_TAXONOMY_VERSION,
  MISSION_PLANNER_VERSION,
  type AgentTaskDetail,
} from "@ai-staffing-os/shared";
import { DEFAULT_MISSION_RESTRICTIONS, type MissionRestrictions } from "@ai-staffing-os/agents";
import { getTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { createQueuedTask, toAgentTaskDetail } from "./task-executor";
import { structuredIntentSchema, missionPlanSchema, type StructuredIntent, type MissionPlan } from "../ceo-intelligence/contracts";
import { interpretBusinessIntent } from "../ceo-intelligence/intent-interpreter";
import { buildMissionPlan } from "../ceo-intelligence/mission-planner";

/**
 * F7.2: integración de F7.1 (interpretBusinessIntent + buildMissionPlan,
 * apps/api/src/modules/ceo-intelligence/ — módulo puro, NO modificado
 * acá) con el flujo real de creación de misiones del CEO Agent.
 *
 * Estrategia de coexistencia explícita (pedida por el PO):
 * - `POST /missions` (mission-orchestrator.ts's launchMission, SIN
 *   TOCAR) sigue siendo el flujo real de siempre — interpretDailyDirective
 *   (LLM real) + ejecución completa del pipeline (discovery, contactos,
 *   campañas, etc.).
 * - `POST /missions/plan` (este archivo, planMissionOnly) es un camino
 *   NUEVO y separado: usa EXCLUSIVAMENTE el intérprete/planner
 *   deterministas de F7.1, nunca llama a interpretDailyDirective ni a
 *   OpenAI, y se detiene después de persistir la interpretación + el
 *   plan. Cero AgentTask hijo, cero Company/Lead/Opportunity/Campaign.
 * - Cuándo se usaría un fallback a interpretDailyDirective (LLM): solo
 *   cuando `confidence` es baja o `ambiguities` no está vacío — F7.2 se
 *   limita a REGISTRAR esa señal en `ceoIntentMeta.warnings` (ver
 *   buildFallbackNote más abajo); nunca invoca el fallback de verdad,
 *   porque F7.2 tiene prohibido llamar a OpenAI. Activarlo de verdad es
 *   una decisión de una fase futura, no de esta.
 */

const CONFIDENCE_FALLBACK_THRESHOLD = 0.5;

function buildFallbackNote(intent: StructuredIntent): string | null {
  if (intent.confidence >= CONFIDENCE_FALLBACK_THRESHOLD && intent.ambiguities.length === 0) return null;
  return (
    `Confianza del intérprete determinista: ${intent.confidence.toFixed(2)} ` +
    `(${intent.ambiguities.length} ambigüedad(es) detectada(s)) — en una fase futura autorizada, ` +
    `esto activaría un fallback opcional a interpretDailyDirective (LLM); F7.2 no lo ejecuta (cero llamadas a OpenAI en esta fase).`
  );
}

// Mismo criterio que buildRestrictionNotes en mission-orchestrator.ts
// (función privada de ese archivo, no exportada — se replica acá en vez
// de tocar ese módulo, ver la regla de "no reabras" de esta fase).
function buildRestrictionNotesLocal(restrictions: MissionRestrictions): string[] {
  const notes: string[] = [];
  if (!restrictions.allowCampaignCreation) notes.push("No se creó ninguna Campaign — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOpportunityCreation) notes.push("No se crearon Opportunities — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOutreach) notes.push("No se planificó ninguna secuencia de outreach — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowMessageSending) notes.push("No se redactó ningún mensaje/borrador — la instrucción lo prohibió explícitamente.");
  return notes;
}

/**
 * Crea una misión en modo SOLO PLANIFICACIÓN: interpreta la instrucción,
 * construye el Mission Plan, valida ambos contra sus contratos Zod, y
 * persiste todo en el mismo AgentTask (type: "daily_revenue_mission",
 * para que aparezca en el Mission Detail existente) — nunca ejecuta
 * ninguna herramienta externa, nunca crea Company/Lead/Opportunity/
 * Campaign/AgentTask hijo. AgentTask.status queda "DONE" (ese enum real
 * no tiene un valor "PLANNED" y no se cambia sin aprobación) — el hecho
 * de que sea solo un plan vive en output.missionState="PLANNED" y
 * output.missionPhase="PLANNED", ambos explícitos.
 */
export async function planMissionOnly(rawInstruction: string): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const intent = structuredIntentSchema.parse(interpretBusinessIntent(rawInstruction));
  const plan: MissionPlan = missionPlanSchema.parse(buildMissionPlan(intent));

  const task = await createQueuedTask({
    agentKey: "ceo",
    type: "daily_revenue_mission",
    input: {
      rawInstruction,
      // F14: mismo campo que launchMission (mission-orchestrator.ts) --
      // ver el comentario ahí sobre por qué vive en `input` en vez de
      // una columna dedicada.
      launchedByUserId: ctx.userId,
      // Campos heredados del shape viejo (interpretDailyDirective) —
      // derivados del StructuredIntent nuevo para que el Mission
      // list/detail existente (missions/service.ts's toListItem, sin
      // modificar su lógica de lectura) siga funcionando para misiones
      // planificadas con el intérprete nuevo. Nunca se inventa un dato:
      // todo sale de `intent`.
      industryNames: intent.industries,
      state: intent.states[0] ?? null,
      city: intent.preferredCities[0] ?? null,
      categoryNames: [],
      desiredVolume: intent.objective.targetCompanyCount,
      businessObjective: {
        type: "companies_found",
        target: intent.objective.targetCompanyCount,
        unit: "empresas",
        rawText: intent.objective.rawText,
      },
      unrecognizedTerms: intent.unsupportedCapabilities,
      missionRestrictions: intent.restrictions,
      useExternalDiscovery: false,
      externalSearchTerms: [],
    },
    triggeredBy: "USER",
  });

  const restrictions = intent.restrictions ?? DEFAULT_MISSION_RESTRICTIONS;
  const restrictionNotes = buildRestrictionNotesLocal(restrictions);
  const fallbackNote = buildFallbackNote(intent);
  const warnings = [...intent.ambiguities, ...(fallbackNote ? [fallbackNote] : [])];
  const now = new Date();

  await scopedDb.agentTask.update({
    where: { id: task.id },
    data: {
      status: "DONE",
      completedAt: now,
      output: {
        missionState: "PLANNED",
        missionPhase: "PLANNED",
        companiesTargeted: 0,
        leadsCreated: 0,
        opportunitiesCreated: 0,
        sequencesPlanned: 0,
        draftsAwaitingApproval: 0,
        costUsdSoFar: 0,
        objectiveProgress: {
          type: "companies_found",
          target: intent.objective.targetCompanyCount,
          unit: "empresas",
          current: 0,
          percentComplete: null,
          rawText: intent.objective.rawText,
        },
        progressUpdatedAt: now.toISOString(),
        error: null,
        appliedRestrictions: restrictions,
        restrictionNotes,
        report: null,
        contactCoverage: null,
        // ---- F7.2: lo nuevo de esta fase ----
        ceoIntent: intent,
        missionPlan: plan,
        ceoIntentMeta: {
          schemaVersion: CEO_INTENT_SCHEMA_VERSION,
          taxonomyVersion: BUSINESS_TAXONOMY_VERSION,
          plannerVersion: MISSION_PLANNER_VERSION,
          createdAt: now.toISOString(),
          warnings,
        },
      } as never,
    },
  });

  await logActivity({
    entityType: "mission",
    entityId: task.id,
    type: "SYSTEM",
    subject: `Plan de misión generado (sin ejecutar): ${intent.companyTypes[0] ?? intent.objective.rawText}`,
  });

  await logAuditEvent({
    action: "mission.planned",
    entityType: "mission",
    entityId: task.id,
    after: {
      matchedTaxonomyKeys: intent.matchedTaxonomyKeys,
      plannedSteps: intent.plannedSteps,
      confidence: intent.confidence,
      schemaVersion: CEO_INTENT_SCHEMA_VERSION,
      taxonomyVersion: BUSINESS_TAXONOMY_VERSION,
      plannerVersion: MISSION_PLANNER_VERSION,
    },
  });

  return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: task.id } }));
}
