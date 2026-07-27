import { z } from "zod";
import { Prisma, type AgentTask } from "@ai-staffing-os/db";
import { interpretBusinessIntent } from "../ceo-intelligence/intent-interpreter";
import { buildMissionPlan } from "../ceo-intelligence/mission-planner";
import { SUPPORTED_STATE_CODES } from "../ceo-intelligence/geo";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { logAuditEvent } from "../../core/audit-log";
import { logger } from "../../core/logger";
import { resolveAgentInstance } from "./task-executor";
import { PIPELINE_FLAGS, type PipelineFlags } from "../../core/pipeline-flags";

/**
 * F25.2 (activación controlada del pipeline real, Prioridad 1):
 * productor real de AgentTask -- recibe una misión piloto estructurada
 * y crea la PRIMERA tarea real (discover_companies) que el Orchestrator
 * (Fase 4) puede reclamar.
 *
 * AUDITORÍA PREVIA (obligatoria antes de agregar una entidad nueva):
 * ya existe un módulo `missions/` completo (POST /missions,
 * instrucción en lenguaje natural -> interpretBusinessIntent ->
 * buildMissionPlan -> ejecución DIRECTA vía task-executor.ts, camino
 * viejo). NO se duplica ese módulo ni su contrato -- esta misión
 * piloto es deliberadamente una ruta DISTINTA
 * (POST /api/v1/agents/missions, bajo el namespace de agents, no de
 * missions) porque el mecanismo de ejecución es fundamentalmente
 * distinto (cola + Orchestrator, Fase 3/4, no el camino directo). Se
 * REUSA sin cambios el intérprete determinista real
 * (interpretBusinessIntent, cero LLM) y el planner real
 * (buildMissionPlan) -- ninguno de los dos se toca ni se reimplementa.
 *
 * NO se crea una tabla `Mission` nueva. El AgentTask raíz (type=
 * "discover_companies") ES la misión -- `correlationId` la identifica
 * (mismo criterio que la observabilidad de Fase 9: toda la timeline de
 * una misión ya se reconstruye agrupando por correlationId). Los
 * metadatos de la misión piloto (nombre/industria/trade/región/límite/
 * dryRun/createdBy) viven dentro de `AgentTask.input` (Json) -- ninguna
 * columna nueva salvo `idempotencyKey` (aditiva, mismo patrón que
 * DomainEvent.idempotencyKey de Fase 2).
 */

export const pilotMissionInputSchema = z.object({
  name: z.string().min(1),
  industry: z.string().min(1),
  // Texto libre -- alimenta el mismo intérprete determinista que ya usa
  // POST /missions con lenguaje natural (interpretBusinessIntent, F7.1,
  // sin LLM). Ej: "electrical contractors", "hoteles".
  trade: z.string().min(1),
  region: z.object({
    state: z.string().length(2),
    cities: z.array(z.string().min(1)).min(1),
  }),
  companyLimit: z.number().int().min(1).max(100),
  // Restricción absoluta de esta sesión -- rechazado si no es 1, nunca
  // silenciosamente forzado.
  autonomyLevel: z.literal(1),
  dryRun: z.boolean().default(false),
  // Requerido explícitamente -- el productor nunca genera uno por
  // detrás; el caller declara qué cuenta como "la misma solicitud".
  idempotencyKey: z.string().min(1),
  budgetUsd: z.number().positive().optional(),
});
export type PilotMissionInput = z.infer<typeof pilotMissionInputSchema>;

export interface PilotMissionResult {
  missionTaskId: string;
  correlationId: string;
  status: string;
  alreadyExisted: boolean;
  dryRun: boolean;
  plan?: ReturnType<typeof buildMissionPlan>;
}

/**
 * Crea (o devuelve, si ya existe -- idempotencia real de DB) la
 * primera AgentTask real de una misión piloto. `dryRun=true` nunca
 * escribe ningún AgentTask -- solo devuelve el plan que se hubiera
 * usado, mismo espíritu que POST /missions/plan (camino viejo).
 *
 * `flags` sigue el mismo patrón de inyección que
 * `registerPipelineHandlers`/`buildProductionOrchestrator`
 * (pipeline-handlers.ts, orchestrator-scheduler.ts): default al
 * singleton real `PIPELINE_FLAGS`, override explícito solo en tests
 * que necesitan ejercitar el pipeline con el flag encendido sin mutar
 * variables de entorno globales.
 */
export async function createPilotMission(input: PilotMissionInput, flags: PipelineFlags = PIPELINE_FLAGS): Promise<PilotMissionResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  if (!flags.missionTaskProductionEnabled) {
    throw new AppError(403, "PIPELINE_DISABLED", "missionTaskProductionEnabled está apagado -- ver PIPELINE_FLAGS.");
  }
  if (input.autonomyLevel !== 1) {
    throw new AppError(400, "AUTONOMY_LEVEL_NOT_SUPPORTED", "Esta sesión solo admite autonomyLevel=1.");
  }
  if (!SUPPORTED_STATE_CODES[input.region.state]) {
    throw new AppError(400, "UNSUPPORTED_STATE", `Estado "${input.region.state}" no soportado.`);
  }

  const instruction = `Busca ${input.companyLimit} ${input.trade} en ${input.region.cities.join(", ")}, ${input.region.state}.`;
  const intent = interpretBusinessIntent(instruction);
  if (intent.matchedTaxonomyKeys.length === 0) {
    throw new AppError(
      422,
      "TRADE_NOT_RECOGNIZED",
      `"${input.trade}" no matcheó ninguna entrada real de la taxonomía de negocio -- nunca se inventa un plan sin evidencia.`,
    );
  }
  intent.objective.targetCompanyCount = input.companyLimit;
  const plan = buildMissionPlan(intent);
  if (input.budgetUsd) plan.stopConditions.maxCostUsd = input.budgetUsd;

  if (input.dryRun) {
    return { missionTaskId: "", correlationId: "", status: "DRY_RUN", alreadyExisted: false, dryRun: true, plan };
  }

  const agentInstance = await resolveAgentInstance("discovery");
  const correlationId = `mission_${input.idempotencyKey.slice(0, 40)}`;

  const missionInput = {
    plan,
    restrictions: intent.restrictions,
    businessActivities: intent.businessActivities,
    targetJobTitles: intent.targetJobTitles,
    decisionRoles: intent.decisionRoles,
    pilotMeta: {
      name: input.name,
      industry: input.industry,
      trade: input.trade,
      region: input.region,
      companyLimit: input.companyLimit,
      createdBy: ctx.userId,
      autonomyLevel: input.autonomyLevel,
    },
  };

  let task: AgentTask;
  const alreadyExisted = false;
  try {
    task = await scopedDb.agentTask.create({
      data: {
        tenantId: ctx.tenantId,
        agentInstanceId: agentInstance.id,
        type: "discover_companies",
        input: missionInput as Prisma.InputJsonValue,
        status: "QUEUED",
        triggeredBy: "USER",
        correlationId,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await scopedDb.agentTask.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        logger.info("pilot_mission_idempotent_replay", { idempotencyKey: input.idempotencyKey, missionTaskId: existing.id });
        return { missionTaskId: existing.id, correlationId: existing.correlationId ?? correlationId, status: existing.status, alreadyExisted: true, dryRun: false };
      }
    }
    throw err;
  }

  // missionTaskId se completa DESPUÉS de crear (discoveryTaskInputSchema
  // lo espera dentro de `input`, pero el id real solo existe una vez
  // creada la fila) -- segundo write mínimo, no un camino caliente.
  task = await scopedDb.agentTask.update({
    where: { id: task.id },
    data: { input: { ...missionInput, missionTaskId: task.id } as Prisma.InputJsonValue },
  });

  await logAuditEvent({
    action: "mission.pilot_created",
    entityType: "agentTask",
    entityId: task.id,
    after: { name: input.name, trade: input.trade, region: input.region, companyLimit: input.companyLimit, correlationId },
  });
  logger.info("pilot_mission_created", { missionTaskId: task.id, correlationId, tenantId: ctx.tenantId });

  return { missionTaskId: task.id, correlationId, status: task.status, alreadyExisted, dryRun: false, plan };
}
