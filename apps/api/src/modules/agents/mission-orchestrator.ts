import type { AgentTaskDetail, MissionState } from "@ai-staffing-os/shared";
import type { InterpretDailyDirectiveResult } from "@ai-staffing-os/agents";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { createAndRunTaskSync, createQueuedTask, runCeoToolDirectly, toAgentTaskDetail } from "./task-executor";
import { computeMissionProgress } from "./tools/ceo-tools.impl";
import { abortTask } from "./cancellation";

// F4 addendum: tope general por misión, independiente del desiredVolume
// interpretado — mismo espíritu que el tope de 15/corrida de F3 y el de
// 50/corrida de selectTargetCompanies (F4 §11).
const MAX_COMPANIES_PER_MISSION = 50;
const DEFAULT_DAILY_MISSION_BUDGET_USD = 3;

// Bugfix de ciclo de vida (misión atascada en RUNNING para siempre):
// tope duro de tiempo real de pared por misión, y umbral de inactividad
// que usa el watchdog del scheduler — ambos configurables por tenant
// (Tenant.settings, mismo patrón que dailyMissionBudgetUsd) sin agregar
// columnas nuevas.
const DEFAULT_MISSION_TIMEOUT_MINUTES = 60;
const DEFAULT_MISSION_STALE_MINUTES = 10;

type MissionInput = { rawInstruction: string } & Partial<InterpretDailyDirectiveResult>;
interface MissionOutput {
  missionState: MissionState;
  companiesTargeted: number;
  leadsCreated: number;
  opportunitiesCreated: number;
  sequencesPlanned: number;
  draftsAwaitingApproval: number;
  costUsdSoFar: number;
  objectiveProgress?: unknown;
  report?: string | null;
  // bugfix de ciclo de vida: heartbeat + error visible en Mission Detail.
  progressUpdatedAt: string;
  error?: string | null;
}

function log(missionTaskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[mission] ${event}`, JSON.stringify({ missionTaskId, ...data }));
}

export async function getMissionSettings(tenantId: string) {
  const tenant = await scopedDb.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings ?? {}) as {
    dailyMissionBudgetUsd?: number;
    missionTimeoutMinutes?: number;
    missionStaleMinutes?: number;
  };
  return {
    budgetUsd: settings.dailyMissionBudgetUsd ?? DEFAULT_DAILY_MISSION_BUDGET_USD,
    timeoutMinutes: settings.missionTimeoutMinutes ?? DEFAULT_MISSION_TIMEOUT_MINUTES,
    staleMinutes: settings.missionStaleMinutes ?? DEFAULT_MISSION_STALE_MINUTES,
  };
}

async function getMissionBudgetStatus(tenantId: string, missionTaskId: string) {
  const { budgetUsd } = await getMissionSettings(tenantId);
  const progress = await computeMissionProgress(missionTaskId);
  return { spentUsd: progress.costUsdSoFar, budgetUsd, exceeded: progress.costUsdSoFar >= budgetUsd };
}

/**
 * Bugfix de ciclo de vida: tope de tiempo real de pared, independiente
 * del presupuesto de IA — una misión que no gasta nada (ej. discovery
 * fallando una y otra vez con costo ~$0) igual necesita un límite para no
 * quedar "viva" indefinidamente.
 */
async function getMissionTimeoutStatus(tenantId: string, missionCreatedAt: Date) {
  const { timeoutMinutes } = await getMissionSettings(tenantId);
  const elapsedMinutes = (Date.now() - missionCreatedAt.getTime()) / 60_000;
  return { elapsedMinutes, timeoutMinutes, exceeded: elapsedMinutes >= timeoutMinutes };
}

/**
 * Bugfix de ciclo de vida: chequeo cooperativo — antes de arrancar cada
 * paso nuevo del pipeline, el orquestador vuelve a leer el missionState
 * real desde la base (no confía en la variable en memoria) para saber si
 * un humano pidió pausar/cancelar MIENTRAS el pipeline seguía corriendo
 * en background. Antes esto no se chequeaba nunca dentro del loop — un
 * "Cancelar" solo cambiaba una etiqueta que el pipeline ignoraba por
 * completo y seguía trabajando.
 */
async function getCurrentMissionState(missionTaskId: string): Promise<MissionState> {
  const task = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } });
  return ((task?.output as { missionState?: MissionState } | null)?.missionState ?? "RUNNING") as MissionState;
}

/**
 * Bugfix de ciclo de vida — carrera real encontrada al probar el abort:
 * el pipeline llama a esto como heartbeat después de cada paso ("sigo
 * corriendo, en RUNNING"), pero un humano puede cancelar/pausar la
 * misión EN PARALELO mientras un paso está en vuelo. Sin este chequeo,
 * el heartbeat pisaba el CANCELLED que el handler de "Cancelar" acababa
 * de escribir un instante antes, el pipeline seguía de largo sin
 * notarlo (el próximo checkForStop() ya leía "RUNNING" otra vez) y la
 * misión terminaba COMPLETED en vez de CANCELLED. Ahora: si el estado
 * real en la DB ya no es RUNNING/PAUSED_BUDGET (es decir, alguien más ya
 * tomó una decisión terminal o de pausa), este heartbeat no escribe
 * nada — deja que esa decisión se mantenga.
 */
async function syncMissionOutput(missionTaskId: string, missionState: MissionState): Promise<void> {
  const currentState = await getCurrentMissionState(missionTaskId);
  if (currentState !== "RUNNING" && currentState !== "PAUSED_BUDGET") return;

  const progress = await computeMissionProgress(missionTaskId);
  const output: MissionOutput = {
    missionState,
    companiesTargeted: progress.companiesTargeted,
    leadsCreated: progress.leadsCreated,
    opportunitiesCreated: progress.opportunitiesCreated,
    sequencesPlanned: progress.sequencesPlanned,
    draftsAwaitingApproval: progress.draftsAwaitingApproval,
    costUsdSoFar: progress.costUsdSoFar,
    objectiveProgress: progress.objectiveProgress,
    progressUpdatedAt: new Date().toISOString(),
    error: null,
  };
  await scopedDb.agentTask.update({ where: { id: missionTaskId }, data: { output: output as never } });
}

/**
 * Bugfix de ciclo de vida: transición terminal real — pone tanto
 * output.missionState=FAILED como AgentTask.status=FAILED (antes nunca
 * pasaba nada de esto: una excepción en el pipeline solo se logueaba a
 * consola y la misión se quedaba en RUNNING para siempre, sin error
 * visible y bloqueando "una misión por día"). No depende de ninguna
 * llamada externa (ni al LLM) — tiene que poder cerrar una misión
 * incluso si lo que falló fue justamente una llamada externa.
 */
async function failMission(missionTaskId: string, errorMessage: string): Promise<void> {
  const progress = await computeMissionProgress(missionTaskId).catch(() => null);
  const output: MissionOutput = {
    missionState: "FAILED",
    companiesTargeted: progress?.companiesTargeted ?? 0,
    leadsCreated: progress?.leadsCreated ?? 0,
    opportunitiesCreated: progress?.opportunitiesCreated ?? 0,
    sequencesPlanned: progress?.sequencesPlanned ?? 0,
    draftsAwaitingApproval: progress?.draftsAwaitingApproval ?? 0,
    costUsdSoFar: progress?.costUsdSoFar ?? 0,
    objectiveProgress: progress?.objectiveProgress,
    progressUpdatedAt: new Date().toISOString(),
    error: errorMessage,
  };
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "FAILED", errorMessage, completedAt: new Date(), output: output as never },
  });
  log(missionTaskId, "mission failed", { error: errorMessage });
}

/** Bugfix de ciclo de vida: transición terminal real para cancelación — AgentTask.status deja de quedarse en RUNNING para siempre. */
async function markMissionCancelled(missionTaskId: string): Promise<void> {
  const progress = await computeMissionProgress(missionTaskId);
  const output: MissionOutput = {
    missionState: "CANCELLED",
    companiesTargeted: progress.companiesTargeted,
    leadsCreated: progress.leadsCreated,
    opportunitiesCreated: progress.opportunitiesCreated,
    sequencesPlanned: progress.sequencesPlanned,
    draftsAwaitingApproval: progress.draftsAwaitingApproval,
    costUsdSoFar: progress.costUsdSoFar,
    objectiveProgress: progress.objectiveProgress,
    progressUpdatedAt: new Date().toISOString(),
    error: null,
  };
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "DONE", completedAt: new Date(), output: output as never },
  });
  log(missionTaskId, "mission cancelled");
}

/**
 * F4 addendum: secuencia FIJA y determinista — el CEO Agent no decide
 * qué tool llamar ni en qué orden, eso ya está escrito acá. Cada
 * delegación usa parentTaskId = missionTaskId (árbol de un solo nivel,
 * ver el addendum de F4_AUTONOMOUS_OUTREACH_PLAN.md). Nunca inventa
 * empresas/contactos, nunca envía nada, nunca fija tarifas — cada tool
 * que reutiliza ya tenía esas garantías desde F2/F3.
 */
async function runMissionPipeline(missionTaskId: string, tenantId: string, operatorUserId: string): Promise<void> {
  const missionTask = await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } });
  const interpreted = missionTask.input as unknown as MissionInput;

  log(missionTaskId, "mission started", {
    rawInstruction: interpreted.rawInstruction,
    useExternalDiscovery: interpreted.useExternalDiscovery ?? false,
    industryNames: interpreted.industryNames ?? [],
    state: interpreted.state ?? null,
  });

  const industries = interpreted.industryNames?.length
    ? await scopedDb.industry.findMany({ where: { name: { in: interpreted.industryNames } } })
    : [];
  const categories = interpreted.categoryNames?.length
    ? await scopedDb.jobCategory.findMany({ where: { name: { in: interpreted.categoryNames } } })
    : [];
  const categoryIds = categories.map((c) => c.id);

  const industryTargets: Array<{ id: string; name: string } | null> = industries.length > 0 ? industries : [null];
  const perCampaignVolume = Math.min(interpreted.desiredVolume ?? MAX_COMPANIES_PER_MISSION, MAX_COMPANIES_PER_MISSION);

  /**
   * Bugfix de ciclo de vida: chequeo único reutilizado antes de cada paso
   * del pipeline — corta la ejecución por presupuesto excedido, por
   * timeout global excedido, o porque un humano pidió pausar/cancelar
   * MIENTRAS el pipeline seguía corriendo en background (antes esto no
   * se chequeaba nunca dentro del loop: "Cancelar" solo cambiaba una
   * etiqueta en la DB que el pipeline ignoraba por completo). Devuelve
   * "stop" cuando el llamador debe cortar de inmediato sin tocar más
   * output — la transición de estado ya quedó hecha acá adentro.
   */
  async function checkForStop(): Promise<"continue" | "stop"> {
    const currentState = await getCurrentMissionState(missionTaskId);
    if (currentState === "CANCELLED") {
      await markMissionCancelled(missionTaskId);
      return "stop";
    }
    if (currentState === "PAUSED_BY_USER") {
      log(missionTaskId, "mission paused");
      return "stop"; // se deja tal cual está en la DB — no se pisa con syncMissionOutput
    }

    const timeoutStatus = await getMissionTimeoutStatus(tenantId, missionTask.createdAt);
    if (timeoutStatus.exceeded) {
      await failMission(
        missionTaskId,
        `Tiempo máximo de misión excedido (${timeoutStatus.timeoutMinutes} min) — se detuvo automáticamente para no quedar corriendo indefinidamente.`,
      );
      return "stop";
    }

    if ((await getMissionBudgetStatus(tenantId, missionTaskId)).exceeded) {
      await syncMissionOutput(missionTaskId, "PAUSED_BUDGET");
      return "stop";
    }

    return "continue";
  }

  for (const industry of industryTargets) {
    if ((await checkForStop()) === "stop") return;

    const campaignName = `${industry?.name ?? "Prospección general"}${interpreted.state ? ` ${interpreted.state}` : ""} — misión ${new Date().toISOString().slice(0, 10)}`;

    const campaignTask = await createAndRunTaskSync(tenantId, operatorUserId, {
      agentKey: "campaign",
      type: "create_campaign",
      input: {
        name: campaignName,
        industryId: industry?.id,
        state: interpreted.state ?? undefined,
        city: interpreted.city ?? undefined,
        targetCategoryIds: categoryIds.length > 0 ? categoryIds : undefined,
        priority: "MEDIUM",
      },
      triggeredBy: "AGENT",
      parentTaskId: missionTaskId,
    });
    await syncMissionOutput(missionTaskId, "RUNNING");
    if (campaignTask.status === "FAILED" || !campaignTask.output) continue;
    const campaignId = (campaignTask.output as { campaignId: string }).campaignId;

    // F4.5A: solo cuando el CEO Agent marcó useExternalDiscovery=true (la
    // instrucción pidió explícitamente empresas FUERA del CRM) y hay
    // industria+estado concretos (discoverCompanies los necesita, nunca
    // busca "cualquier industria/estado"). Crea Company nuevas con
    // origin=EXTERNAL_DISCOVERY — select_target_companies (abajo, sin
    // cambios) las recoge igual que a cualquier otra porque ya cumplen
    // los criterios de la campaña.
    if (interpreted.useExternalDiscovery && interpreted.state && industry) {
      if ((await checkForStop()) === "stop") return;
      log(missionTaskId, "discovery delegated", { industry: industry.name, state: interpreted.state });
      const discoverTask = await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "discovery",
        type: "discover_companies",
        input: {
          industryNames: [industry.name],
          state: interpreted.state,
          city: interpreted.city ?? undefined,
          limit: perCampaignVolume,
        },
        triggeredBy: "AGENT",
        parentTaskId: missionTaskId,
      });
      // Un discover_companies FAILED (ej. estado sin mapeo de área, fuente
      // caída) no aborta la misión: select_target_companies de abajo
      // simplemente no encuentra empresas nuevas — resultado real, no se
      // inventa nada para compensar.
      await syncMissionOutput(missionTaskId, "RUNNING");

      // F4.6: Contact Intelligence corre acá — después de Discovery,
      // antes de Outreach (que en este piloto ni siquiera llega a correr,
      // ver más abajo) — solo sobre las Company que ESTA tarea acaba de
      // crear, nunca sobre empresas ya existentes en el CRM (esas ya
      // pasaron por su propio ciclo de prospección en F2/F3).
      const newCompanyIds = (
        (discoverTask.output as { companiesCreated?: Array<{ companyId: string }> } | null)?.companiesCreated ?? []
      ).map((c) => c.companyId);
      for (const newCompanyId of newCompanyIds) {
        if ((await checkForStop()) === "stop") return;
        log(missionTaskId, "contact intelligence delegated", { companyId: newCompanyId });
        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "contact_intelligence",
          type: "find_contacts",
          input: { companyId: newCompanyId },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
        // Un find_contacts FAILED (proveedor caído/sin configurar) no
        // aborta la misión — la Company queda sin contactos, resultado
        // real, no se inventa nada para compensar.
        await syncMissionOutput(missionTaskId, "RUNNING");

        // F4.7: Email Intelligence corre justo después — mismo agente
        // (Contact Intelligence, ampliado), mismo punto del pipeline
        // (después de Discovery/find_contacts, antes de Sales Review).
        // Sin contactId: procesa todos los Contact de esta Company sin
        // email VERIFIED todavía (incluye los recién creados arriba).
        if ((await checkForStop()) === "stop") return;
        log(missionTaskId, "email intelligence delegated", { companyId: newCompanyId });
        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "contact_intelligence",
          type: "find_email",
          input: { companyId: newCompanyId },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
        await syncMissionOutput(missionTaskId, "RUNNING");
      }
    }

    if ((await checkForStop()) === "stop") return;
    const selectTask = await createAndRunTaskSync(tenantId, operatorUserId, {
      agentKey: "campaign",
      type: "select_target_companies",
      input: { campaignId, limit: perCampaignVolume },
      triggeredBy: "AGENT",
      parentTaskId: missionTaskId,
    });
    await syncMissionOutput(missionTaskId, "RUNNING");
    if (selectTask.status === "FAILED" || !selectTask.output) continue;
    const companyIds = (selectTask.output as { companyIds: string[] }).companyIds;

    for (const companyId of companyIds) {
      if ((await checkForStop()) === "stop") return;

      const company = await scopedDb.company.findUnique({ where: { id: companyId } });
      if (!company) continue;

      if (company.commercialScore == null) {
        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "sales",
          type: "score_company",
          input: { companyId },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
      }

      let lead = await scopedDb.lead.findFirst({ where: { companyId } });
      if (!lead) {
        const leadTask = await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "sales",
          type: "create_lead",
          input: {
            companyId,
            industryId: company.industryId,
            city: company.city ?? undefined,
            state: company.state ?? undefined,
            source: interpreted.useExternalDiscovery ? "external-discovery-mission" : "daily-revenue-mission",
          },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
        if (leadTask.status !== "FAILED" && leadTask.output) {
          const leadId = (leadTask.output as { leadId: string }).leadId;
          lead = await scopedDb.lead.findUnique({ where: { id: leadId } });
          // F4.5A §"No crear ni enviar outreach automáticamente en esta
          // fase piloto": una misión de descubrimiento externo se detiene
          // acá — califica y crea el Lead, nunca abre Opportunity ni
          // planifica secuencia/mensaje. El pipeline F4 normal (abajo)
          // sigue exactamente igual para misiones que no piden discovery.
          if (!interpreted.useExternalDiscovery) {
            await createAndRunTaskSync(tenantId, operatorUserId, {
              agentKey: "sales",
              type: "create_opportunity",
              input: { leadId },
              triggeredBy: "AGENT",
              parentTaskId: missionTaskId,
            });
          }
        }
      }

      if (interpreted.useExternalDiscovery) continue;

      const cc = await scopedDb.campaignCompany.findUnique({
        where: { campaignId_companyId: { campaignId, companyId } },
      });
      if (!cc) continue;

      const planTask = await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "outreach",
        type: "plan_sequence",
        input: { campaignCompanyId: cc.id },
        triggeredBy: "AGENT",
        parentTaskId: missionTaskId,
      });
      if (planTask.status === "FAILED") {
        await syncMissionOutput(missionTaskId, "RUNNING");
        continue;
      }

      if ((await checkForStop()) === "stop") return;

      await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "outreach",
        type: "personalize_message",
        input: { campaignCompanyId: cc.id, step: 0 },
        triggeredBy: "AGENT",
        parentTaskId: missionTaskId,
      });
      await syncMissionOutput(missionTaskId, "RUNNING");
    }
  }

  // Bugfix de ciclo de vida: antes, terminar de recorrer todas las
  // industrias/empresas dejaba la misión en RUNNING para siempre — nada
  // la cerraba salvo que un humano clickeara "Cerrar ahora" (o pasara la
  // medianoche y el sweep del scheduler la agarrara). Terminar el
  // recorrido sin que quede trabajo pendiente ES la señal de que la
  // misión terminó — se cierra sola acá, transición obligatoria a
  // COMPLETED. Si closeMission(que llama al LLM para el Executive
  // Report) tira una excepción, el catch de runMissionPipelineAsync la
  // agarra y la misión queda FAILED con el error real — nunca RUNNING.
  await closeMission(missionTaskId);
  log(missionTaskId, "mission completed");
}

function runMissionPipelineAsync(missionTaskId: string, tenantId: string, operatorUserId: string): void {
  runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, () =>
    runMissionPipeline(missionTaskId, tenantId, operatorUserId),
  ).catch(async (err) => {
    // Bugfix de ciclo de vida: antes esto solo hacía console.error — la
    // misión se quedaba en RUNNING para siempre, sin error visible, y
    // bloqueaba "una misión por día" indefinidamente. Ahora toda
    // excepción no manejada del pipeline transiciona la misión a FAILED
    // de verdad, con el mensaje real visible en Mission Detail.
    const message = err instanceof Error ? err.message : "Error desconocido ejecutando el pipeline de la misión";
    console.error(`[mission-orchestrator] pipeline failed for mission ${missionTaskId}:`, err);
    await failMission(missionTaskId, message).catch((failErr) => {
      console.error(`[mission-orchestrator] could not even mark mission ${missionTaskId} as FAILED:`, failErr);
    });
  });
}

/**
 * POST /missions — crea la misión raíz, interpreta la instrucción de
 * forma SÍNCRONA (el humano ve de inmediato qué se entendió) y dispara
 * el resto de la secuencia de forma asíncrona (mismo patrón runTaskAsync
 * ya usado en F2/F3 para trabajo que puede tardar).
 */
export async function launchMission(instruction: string): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Bugfix de ciclo de vida: CANCELLED/COMPLETED/FAILED ahora sí ponen
  // AgentTask.status="DONE"/"FAILED" (ver markMissionCancelled/
  // closeMission/failMission), así que el filtro status:"RUNNING" ya
  // alcanza en la mayoría de los casos. Se mantiene el filtro extra por
  // missionState como red de seguridad ante filas viejas de antes de este
  // fix, que pudieron quedar con status="RUNNING" y un missionState
  // terminal — nunca deben bloquear una misión nueva.
  const TERMINAL_STATES = new Set(["CANCELLED", "COMPLETED", "FAILED"]);
  const runningToday = await scopedDb.agentTask.findMany({
    where: { type: "daily_revenue_mission", status: "RUNNING", createdAt: { gte: todayStart } },
  });
  const existingActive = runningToday.find(
    (t) => !TERMINAL_STATES.has((t.output as { missionState?: string } | null)?.missionState ?? "RUNNING"),
  );
  if (existingActive) {
    // Simplificación deliberada respecto al plan original ("se fusiona
    // con la misión existente"): rechazar con un mensaje claro es más
    // simple y seguro que una lógica de merge de criterios — evita
    // duplicar gasto sin necesitar código de fusión no trivial.
    throw AppError.badRequest(
      "Ya hay una Daily Revenue Mission activa hoy. Pausala o cancelala antes de lanzar una nueva, o esperá a que se cierre.",
    );
  }

  const task = await createQueuedTask({
    agentKey: "ceo",
    type: "daily_revenue_mission",
    input: { rawInstruction: instruction },
    triggeredBy: "USER",
  });
  await scopedDb.agentTask.update({ where: { id: task.id }, data: { status: "RUNNING" } });

  const interpreted = (await runCeoToolDirectly(task.id, "interpretDailyDirective", {
    rawInstruction: instruction,
  })) as InterpretDailyDirectiveResult;

  await scopedDb.agentTask.update({
    where: { id: task.id },
    data: {
      input: { rawInstruction: instruction, ...interpreted } as never,
      output: {
        missionState: "RUNNING",
        companiesTargeted: 0,
        leadsCreated: 0,
        opportunitiesCreated: 0,
        sequencesPlanned: 0,
        draftsAwaitingApproval: 0,
        costUsdSoFar: Number((await scopedDb.agentTask.findUniqueOrThrow({ where: { id: task.id } })).costUsd ?? 0),
        objectiveProgress: {
          type: interpreted.businessObjective.type,
          target: interpreted.businessObjective.target,
          unit: interpreted.businessObjective.unit,
          current: 0,
          percentComplete: interpreted.businessObjective.target ? 0 : null,
          rawText: interpreted.businessObjective.rawText,
        },
        progressUpdatedAt: new Date().toISOString(),
        error: null,
      } as never,
    },
  });

  runMissionPipelineAsync(task.id, ctx.tenantId, ctx.userId);

  return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: task.id } }));
}

/**
 * Bugfix de ciclo de vida: aborta de verdad cualquier tarea hija en
 * vuelo de esta misión (hoy, en la práctica, solo discover_companies
 * hace una llamada de red real que se pueda cortar) — ver
 * cancellation.ts. Sin esto, "Cancelar" solo cambiaba una etiqueta en la
 * UI mientras el fetch seguía corriendo en background hasta que
 * terminara solo.
 */
async function abortInFlightChild(missionTaskId: string, reason: string): Promise<void> {
  const runningChild = await scopedDb.agentTask.findFirst({
    where: { parentTaskId: missionTaskId, status: "RUNNING" },
  });
  if (runningChild) {
    const aborted = abortTask(runningChild.id, reason);
    log(missionTaskId, "abort requested", { childTaskId: runningChild.id, childType: runningChild.type, aborted });
  }
}

/**
 * Bugfix de ciclo de vida: herramienta administrativa compartida — la
 * usa tanto la acción "recover" del PATCH (un humano la dispara a mano)
 * como el watchdog del scheduler (automático, misión same-day sin
 * actividad por más de missionStaleMinutes). Nunca depende de una
 * llamada externa: aborta lo que esté en vuelo y fuerza FAILED
 * directamente, sin pasar por closeMission/el LLM.
 */
export async function recoverStuckMission(missionTaskId: string, reason: string): Promise<void> {
  await abortInFlightChild(missionTaskId, reason);
  await failMission(missionTaskId, reason);
}

/** PATCH /missions/:id — pausar/reanudar/cancelar/cerrar ahora/recuperar. */
export async function applyMissionAction(
  missionTaskId: string,
  action: "pause" | "resume" | "cancel" | "close_now" | "recover",
): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const task = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId } });
  if (!task || task.type !== "daily_revenue_mission") throw AppError.notFound("Mission not found");

  if (action === "close_now") {
    await closeMission(missionTaskId);
    log(missionTaskId, "mission completed", { trigger: "manual close_now" });
    return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } }));
  }

  // Bugfix de ciclo de vida: herramienta administrativa para una misión
  // atascada en RUNNING sin actividad — fuerza FAILED sin depender de
  // ninguna llamada externa (ni siquiera del LLM del Executive Report),
  // porque el punto es recuperarla incluso si algo externo dejó de
  // responder. Funciona sin importar el missionState actual.
  if (action === "recover") {
    await recoverStuckMission(
      missionTaskId,
      "Misión recuperada manualmente con la herramienta administrativa — estaba atascada en RUNNING sin actividad.",
    );
    return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } }));
  }

  if (action === "cancel") {
    await abortInFlightChild(missionTaskId, "mission cancelled by user");
    // Transición terminal inmediata: si el pipeline sigue corriendo en
    // background va a notar el missionState=CANCELLED en su próximo
    // checkForStop() y va a llamar a lo mismo — idempotente, no rompe
    // nada que ya haya quedado así. Si el pipeline YA había terminado su
    // trabajo (el caso "atascada sin actividad" reportado), esto es lo
    // único que la saca de RUNNING.
    await markMissionCancelled(missionTaskId);
    return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } }));
  }

  const nextState: MissionState = action === "pause" ? "PAUSED_BY_USER" : "RUNNING";
  const currentOutput = (task.output ?? {}) as unknown as MissionOutput;
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...currentOutput, missionState: nextState, progressUpdatedAt: new Date().toISOString() } as never },
  });
  log(missionTaskId, action === "pause" ? "mission pause requested" : "mission resume requested");

  if (action === "resume") {
    runMissionPipelineAsync(missionTaskId, ctx.tenantId, ctx.userId);
  }

  return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } }));
}

/** Genera el Executive Report y cierra la misión (DONE). */
export async function closeMission(missionTaskId: string): Promise<void> {
  const result = (await runCeoToolDirectly(missionTaskId, "closeDailyMission", { missionTaskId })) as {
    report: string;
    objectiveProgress: unknown;
  };

  const progress = await computeMissionProgress(missionTaskId);
  const output: MissionOutput = {
    missionState: "COMPLETED",
    companiesTargeted: progress.companiesTargeted,
    leadsCreated: progress.leadsCreated,
    opportunitiesCreated: progress.opportunitiesCreated,
    sequencesPlanned: progress.sequencesPlanned,
    draftsAwaitingApproval: progress.draftsAwaitingApproval,
    costUsdSoFar: progress.costUsdSoFar,
    objectiveProgress: result.objectiveProgress,
    report: result.report,
    progressUpdatedAt: new Date().toISOString(),
    error: null,
  };

  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "DONE", completedAt: new Date(), output: output as never },
  });
}

