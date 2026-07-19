import type { AgentTaskDetail, MissionState } from "@ai-staffing-os/shared";
import { CEO_INTENT_SCHEMA_VERSION, BUSINESS_TAXONOMY_VERSION, MISSION_PLANNER_VERSION } from "@ai-staffing-os/shared";
import type { InterpretDailyDirectiveResult, MissionRestrictions } from "@ai-staffing-os/agents";
import { DEFAULT_MISSION_RESTRICTIONS } from "@ai-staffing-os/agents";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { createAndRunTaskSync, createQueuedTask, runCeoToolDirectly, toAgentTaskDetail } from "./task-executor";
import { computeMissionProgress, computeContactCoverage } from "./tools/ceo-tools.impl";
import { abortTask } from "./cancellation";
import { interpretBusinessIntent } from "../ceo-intelligence/intent-interpreter";
import { buildMissionPlan } from "../ceo-intelligence/mission-planner";
import type { MissionPlan } from "../ceo-intelligence/contracts";
import { executeDiscoveryPlan, type DiscoveryExecutionReport } from "./mission-executor";

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
  // Corrección estructural (misión Iowa, 2026-07-13): qué restricciones
  // se aplicaron realmente y qué se saltó por eso — nunca "silencioso".
  appliedRestrictions?: MissionRestrictions;
  restrictionNotes?: string[];
  // Corrección estructural: honestidad del resultado — ver
  // computeContactCoverage()/closeMission(). null mientras la misión
  // sigue corriendo (se calcula recién al cerrar).
  contactCoverage?: {
    companiesConsidered: number;
    companiesWithContactPoint: number;
    companiesWithoutContactPoint: number;
    providersOmitted: string[];
  } | null;
  // F13 (auditoría PO, 2026-07-19): reporte real de descubrimiento
  // externo cuando la oferta interna del CRM no alcanzó lo pedido y se
  // corrió runAutoExternalDiscoveryFallback -- undefined en cualquier
  // misión que encontró suficiente oferta interna (comportamiento sin
  // cambios). Diferencia encontradas/nuevas/reutilizadas/descartadas/
  // enriquecidas/sin-contacto, igual que discoveryExecution del flujo
  // useExternalDiscovery=true explícito.
  discoveryFallback?: DiscoveryExecutionReport | null;
}

function log(missionTaskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[mission] ${event}`, JSON.stringify({ missionTaskId, ...data }));
}

/** Corrección estructural: un mensaje explícito por cada restricción aplicada — nunca silencioso. Usado tanto al lanzar la misión como al arrancar el pipeline. */
function buildRestrictionNotes(restrictions: MissionRestrictions): string[] {
  const notes: string[] = [];
  if (!restrictions.allowCampaignCreation) notes.push("No se creó ninguna Campaign — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOpportunityCreation) notes.push("No se crearon Opportunities — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowOutreach) notes.push("No se planificó ninguna secuencia de outreach — la instrucción lo prohibió explícitamente.");
  if (!restrictions.allowMessageSending) notes.push("No se redactó ningún mensaje/borrador — la instrucción lo prohibió explícitamente.");
  return notes;
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
async function syncMissionOutput(
  missionTaskId: string,
  missionState: MissionState,
  restrictionInfo?: { appliedRestrictions: MissionRestrictions; restrictionNotes: string[] },
): Promise<void> {
  const currentState = await getCurrentMissionState(missionTaskId);
  if (currentState !== "RUNNING" && currentState !== "PAUSED_BUDGET") return;

  // Corrección estructural: los flags/notas de restricciones se calculan
  // una sola vez al arrancar el pipeline — cada heartbeat posterior debe
  // conservarlos (no pisarlos con undefined) leyendo lo que ya hay en DB.
  const existing = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } });
  const existingOutput = (existing?.output ?? {}) as Partial<MissionOutput>;

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
    appliedRestrictions: restrictionInfo?.appliedRestrictions ?? existingOutput.appliedRestrictions,
    restrictionNotes: restrictionInfo?.restrictionNotes ?? existingOutput.restrictionNotes,
    discoveryFallback: existingOutput.discoveryFallback,
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
  const existing = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } }).catch(() => null);
  const existingOutput = (existing?.output ?? {}) as Partial<MissionOutput>;
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
    appliedRestrictions: existingOutput.appliedRestrictions,
    restrictionNotes: existingOutput.restrictionNotes,
    discoveryFallback: existingOutput.discoveryFallback,
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
  const existing = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } });
  const existingOutput = (existing?.output ?? {}) as Partial<MissionOutput>;
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
    appliedRestrictions: existingOutput.appliedRestrictions,
    restrictionNotes: existingOutput.restrictionNotes,
    discoveryFallback: existingOutput.discoveryFallback,
  };
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "DONE", completedAt: new Date(), output: output as never },
  });
  log(missionTaskId, "mission cancelled");
}

/** F13: persiste el reporte real de runAutoExternalDiscoveryFallback sin pisar el resto del output ya escrito (mismo patrón de lectura-antes-de-escribir que syncMissionOutput/closeMission). */
async function persistDiscoveryFallbackReport(missionTaskId: string, report: DiscoveryExecutionReport): Promise<void> {
  const existing = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } });
  const existingOutput = (existing?.output ?? {}) as Partial<MissionOutput>;
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...existingOutput, discoveryFallback: report } as never },
  });
}

/**
 * F13 (auditoría PO, 2026-07-19): antes, una misión "Busca 10 hoteles en
 * Illinois" (sin frases mágicas tipo "fuera del CRM") solo consultaba
 * Company ya existentes en el CRM -- nunca llamaba a Google Places, y
 * si la industria pedida ni existía en el CRM (ej. Hospitality antes de
 * este fix), el filtro quedaba vacío y el código devolvía CUALQUIER
 * empresa del estado sin relación con lo pedido (bug real: la misión de
 * hoteles le redactó outreach a una empresa de logística). Este helper
 * corre descubrimiento externo REAL -- mismo intérprete/planner/
 * ejecutor deterministas que ya usa el desvío useExternalDiscovery
 * explícito (interpretBusinessIntent/buildMissionPlan/executeDiscoveryPlan,
 * ninguno de los tres modificado) -- ANTES de que el loop de siempre
 * lea el CRM. Las Company reales que persiste quedan ahí mismo, así que
 * el loop de abajo (sin ningún cambio) las encuentra con su propia
 * query normal. Nunca crea Lead/Opportunity/Campaign acá -- eso sigue
 * siendo exclusivo del loop de siempre, ahora alimentado también con
 * las empresas recién descubiertas.
 */
async function runAutoExternalDiscoveryFallback(
  missionTaskId: string,
  plan: MissionPlan,
  restrictions: MissionRestrictions,
  businessActivities: string[],
  targetJobTitles: string[],
  decisionRoles: string[],
  categoryIds: string[],
): Promise<void> {
  log(missionTaskId, "auto external discovery fallback started", {
    reason: "internal CRM supply insufficient for the requested volume",
    searchQueries: plan.searchQueries.length,
  });

  const report = await executeDiscoveryPlan({
    missionTaskId,
    plan,
    restrictions,
    businessActivities,
    targetJobTitles,
    decisionRoles,
  });

  // F13: hallazgo real durante la validación -- persistAcceptedCandidate
  // (mission-executor.ts, sin tocar) nunca setea possibleCategories (no
  // conoce las JobCategory reales de la misión, solo taxonomía). Sin
  // esto, selectTargetCompanies (campaign-tools.impl.ts, sin tocar)
  // exige `possibleCategories: { some: { id: { in: targetCategoryIds } } }`
  // cuando la Campaign tiene categorías -- toda empresa recién
  // descubierta quedaba con 0 posibilidad de matchear, así que
  // addedCount siempre daba 0 pese a haber descubierto empresas reales.
  if (categoryIds.length > 0 && report.createdCompanyIds.length > 0) {
    for (const companyId of report.createdCompanyIds) {
      await scopedDb.company.update({
        where: { id: companyId },
        data: { possibleCategories: { connect: categoryIds.map((id) => ({ id })) } },
      });
    }
  }

  await persistDiscoveryFallbackReport(missionTaskId, report);

  log(missionTaskId, "auto external discovery fallback finished", {
    companiesCreated: report.companiesCreated,
    acceptedResults: report.acceptedResults,
    rejectedResults: report.rejectedResults,
    duplicatesAlreadyInCrm: report.duplicatesAlreadyInCrm,
    stopReason: report.stopReason,
    categoriesAttached: categoryIds.length > 0 ? categoryIds.length : 0,
  });
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

  // F7.3: una instrucción que pidió descubrimiento externo ("fuera del
  // CRM") se desvía acá, ANTES del pipeline fijo de siempre — reemplaza
  // el patrón "por cada industria: ejecutar todos los search terms" (el
  // bug estructural reportado) por el ejecutor nuevo (mission-executor.ts),
  // que corre cada query del MissionPlan una sola vez, deduplica
  // globalmente, clasifica, y persiste SOLO Company (nunca Lead/
  // Opportunity/Campaign/Contact). interpretDailyDirective (arriba, ya
  // corrido en launchMission) sigue siendo el gate que decide ESTE
  // desvío (useExternalDiscovery) — coexistencia deliberada: el LLM
  // sigue decidiendo "¿es descubrimiento externo?", pero ya no decide
  // QUÉ ni CÓMO buscar, eso lo hace el intérprete/planner deterministas
  // de F7.1 a partir de acá. La rama de búsqueda interna en el CRM
  // (useExternalDiscovery=false, debajo) sigue exactamente igual que
  // antes de F7.3.
  if (interpreted.useExternalDiscovery) {
    await runDynamicDiscoveryMission(missionTaskId, interpreted.rawInstruction);
    return;
  }

  // F13 (auditoría PO, 2026-07-19): intérprete/planner deterministas
  // (F7.1, sin LLM, gratis) calculados siempre acá -- señal real de qué
  // sector pidió la instrucción, independiente de si el CRM ya tiene una
  // Industry para él. Se usan abajo para (a) decidir si hace falta
  // descubrimiento externo real cuando el CRM no alcanza, y (b) para no
  // confundir "no se pidió ninguna industria" (sí corresponde no
  // filtrar) con "se pidió una industria real que el CRM todavía no
  // tiene" (nunca debe devolver empresas sin relación -- bug real
  // reportado por el PO: una misión de hoteles le mandó outreach a una
  // empresa de logística porque el filtro vacío caía a "cualquier
  // empresa del estado").
  const externalIntent = interpretBusinessIntent(interpreted.rawInstruction);
  const externalPlan = buildMissionPlan(externalIntent);

  const industries = interpreted.industryNames?.length
    ? await scopedDb.industry.findMany({ where: { name: { in: interpreted.industryNames } } })
    : [];
  const categories = interpreted.categoryNames?.length
    ? await scopedDb.jobCategory.findMany({ where: { name: { in: interpreted.categoryNames } } })
    : [];
  const categoryIds = categories.map((c) => c.id);

  const industryTargets: Array<{ id: string; name: string } | null> =
    industries.length > 0 ? industries : externalPlan.searchQueries.length > 0 ? [] : [null];
  const perCampaignVolume = Math.min(interpreted.desiredVolume ?? MAX_COMPANIES_PER_MISSION, MAX_COMPANIES_PER_MISSION);

  // Corrección estructural (misión Iowa, 2026-07-13): antes, "no crear
  // campañas/oportunidades" y "no enviar nada" existían solo como texto
  // en la instrucción — nada en código los leía. `interpreted.missionRestrictions`
  // ya viene combinado (LLM AND detector determinista, ver
  // mission-restrictions.ts) desde interpretDailyDirective; acá solo se
  // aplica un default permisivo por si faltara (misiones viejas antes de
  // este fix, o un parseo defensivo). Se registra explícitamente en el
  // log y en el output — nunca una restricción aplicada en silencio.
  const restrictions: MissionRestrictions = interpreted.missionRestrictions ?? DEFAULT_MISSION_RESTRICTIONS;
  const restrictionNotes = buildRestrictionNotes(restrictions);
  log(missionTaskId, "mission restrictions applied", { restrictions, restrictionNotes });
  await syncMissionOutput(missionTaskId, "RUNNING", { appliedRestrictions: restrictions, restrictionNotes });

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

  // F13: si el CRM no tiene suficiente oferta real para lo pedido (o
  // directamente no tiene la industria todavía), corre descubrimiento
  // externo real UNA VEZ antes del loop de siempre -- ver
  // runAutoExternalDiscoveryFallback más arriba. Las Company reales que
  // persiste quedan disponibles para que el loop de abajo las encuentre
  // con su propia query normal, sin ningún cambio a esa lógica.
  //
  // Hallazgo real de la validación: cuando la instrucción NO pide un
  // número explícito, perCampaignVolume cae al tope general (50) -- eso
  // volvía "obligatorio" el descubrimiento externo real (con costo real
  // de Google Places + website intelligence) para CUALQUIER industria
  // con menos de 50 empresas ya en el CRM, incluso para una instrucción
  // vaga tipo "busca empresas de manufactura" que antes se conformaba
  // con lo que ya hubiera. Se vuelve a exigir un volumen EXPLÍCITO para
  // ese caso (respeta el comportamiento barato de siempre) -- la única
  // excepción real es cuando el CRM no tiene NINGUNA empresa de esa
  // industria (industries.length===0): ahí no hay nada interno de lo
  // que "conformarse" pase lo que pase, así que el fallback corre
  // igual, con o sin número explícito (el caso real que reportó el PO:
  // Hospitality antes de esta fase).
  const explicitVolumeInsufficient = interpreted.desiredVolume != null;
  if (externalPlan.searchQueries.length > 0 && (explicitVolumeInsufficient || industries.length === 0)) {
    const internalSupply =
      industries.length > 0
        ? await scopedDb.company.count({
            where: { industryId: { in: industries.map((i) => i.id) }, state: interpreted.state ?? undefined, city: interpreted.city ?? undefined },
          })
        : 0;
    if (internalSupply < perCampaignVolume) {
      if ((await checkForStop()) === "stop") return;
      await runAutoExternalDiscoveryFallback(
        missionTaskId,
        externalPlan,
        externalIntent.restrictions,
        externalIntent.businessActivities,
        externalIntent.targetJobTitles,
        externalIntent.decisionRoles,
        categoryIds,
      );
      await syncMissionOutput(missionTaskId, "RUNNING", { appliedRestrictions: restrictions, restrictionNotes });
    }
  }

  for (const industry of industryTargets) {
    if ((await checkForStop()) === "stop") return;

    // Corrección estructural (misión Iowa, 2026-07-13): antes esto se
    // creaba SIEMPRE, sin importar qué pidiera la instrucción. Ahora
    // `campaignId` queda `null` cuando la misión lo prohíbe explícitamente
    // — el resto del pipeline (líneas de abajo) lo trata como "no hay
    // campaña" en vez de asumir que siempre existe una.
    let campaignId: string | null = null;
    if (restrictions.allowCampaignCreation) {
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
      campaignId = (campaignTask.output as { campaignId: string }).campaignId;
    } else {
      log(missionTaskId, "campaign creation skipped by restriction", { industry: industry?.name ?? null });
    }

    if ((await checkForStop()) === "stop") return;

    // Corrección estructural: select_target_companies exige un campaignId
    // real (CampaignCompany no puede existir sin Campaign) — cuando la
    // Campaign está prohibida, se resuelve la lista de empresas a
    // procesar sin pasar por ahí, consultando directo por industria/
    // estado/ciudad (mismo criterio de selectTargetCompanies, sin el
    // bookkeeping de CampaignCompany que no aplica sin campaña).
    let companyIds: string[];
    if (campaignId) {
      const selectTask = await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "campaign",
        type: "select_target_companies",
        input: { campaignId, limit: perCampaignVolume },
        triggeredBy: "AGENT",
        parentTaskId: missionTaskId,
      });
      await syncMissionOutput(missionTaskId, "RUNNING");
      if (selectTask.status === "FAILED" || !selectTask.output) continue;
      companyIds = (selectTask.output as { companyIds: string[] }).companyIds;
    } else {
      companyIds = (
        await scopedDb.company.findMany({
          where: {
            industryId: industry?.id ?? undefined,
            state: interpreted.state ?? undefined,
            city: interpreted.city ?? undefined,
          },
          orderBy: [{ commercialScore: "desc" }, { createdAt: "asc" }],
          take: perCampaignVolume,
          select: { id: true },
        })
      ).map((c) => c.id);
      log(missionTaskId, "companies selected without campaign", { count: companyIds.length });
    }

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
            source: "daily-revenue-mission",
          },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
        if (leadTask.status !== "FAILED" && leadTask.output) {
          const leadId = (leadTask.output as { leadId: string }).leadId;
          lead = await scopedDb.lead.findUnique({ where: { id: leadId } });
          // Corrección estructural: `restrictions.allowOpportunityCreation`
          // bloquea esto para cualquier misión que lo pida explícitamente
          // — nunca se abre Opportunity si la instrucción dijo "no crear
          // oportunidades".
          if (restrictions.allowOpportunityCreation) {
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

      // Corrección estructural: sin Campaign no hay CampaignCompany —
      // outreach (plan_sequence/personalize_message) es estructuralmente
      // imposible sin una, independiente de allowOutreach/
      // allowMessageSending (que además también lo bloquean si hay
      // Campaign). No es una limitación oculta: restrictionNotes ya
      // registró explícitamente por qué no se creó la Campaign.
      if (!campaignId || !restrictions.allowOutreach) continue;

      // Pre-F11 audit: CampaignCompany was just added to STRICT_TENANT_MODELS
      // — per the F8 composite-unique-key limitation, findUnique's redirect to
      // findFirst doesn't accept a compound-key field-group name, so this
      // uses the plain-field form (same fix as agents/company-enrichment.ts).
      const cc = await scopedDb.campaignCompany.findFirst({
        where: { campaignId, companyId },
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

      // Corrección estructural: el paso que redacta un borrador de
      // mensaje (lo único que produce contenido pensado para alguien
      // fuera del tenant) tiene su propio flag — se puede planificar la
      // secuencia (arriba) sin necesariamente redactar el primer mensaje,
      // si la instrucción prohibió el envío pero no el plan.
      if (restrictions.allowMessageSending) {
        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "outreach",
          type: "personalize_message",
          input: { campaignCompanyId: cc.id, step: 0 },
          triggeredBy: "AGENT",
          parentTaskId: missionTaskId,
        });
      }
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

/**
 * F7.3: reemplazo del pipeline fijo para instrucciones de descubrimiento
 * externo — delega TODA la lógica de negocio (interpretación, plan,
 * ejecución de queries, dedup global, clasificación, persistencia) al
 * módulo determinista F7.1 (ceo-intelligence/) + el ejecutor F7.3
 * (mission-executor.ts). Esta función es deliberadamente delgada: solo
 * arma el input, llama al ejecutor, y traduce su reporte al mismo
 * AgentTask.output que ya usa el resto de Mission Detail — nunca mezcla
 * lógica de negocio de descubrimiento acá (esa vive en mission-executor.ts,
 * ver el requisito explícito de no concentrar todo en este archivo).
 *
 * Nunca llama a closeMission/closeDailyMission (esa función hace una
 * llamada real a OpenAI para narrar el Executive Report) — el reporte de
 * esta fase es 100% estructurado (discoveryExecution), sin narración de
 * LLM, consistente con que F7.3 tiene prohibido llamar a OpenAI.
 */
async function runDynamicDiscoveryMission(missionTaskId: string, rawInstruction: string): Promise<void> {
  const intent = interpretBusinessIntent(rawInstruction);
  const plan = buildMissionPlan(intent);
  const restrictions = intent.restrictions;
  const restrictionNotes = buildRestrictionNotes(restrictions);

  log(missionTaskId, "dynamic discovery mission started", {
    matchedTaxonomyKeys: intent.matchedTaxonomyKeys,
    plannedSteps: intent.plannedSteps,
    searchQueries: plan.searchQueries.length,
  });

  const report = await executeDiscoveryPlan({
    missionTaskId,
    plan,
    restrictions,
    businessActivities: intent.businessActivities,
    targetJobTitles: intent.targetJobTitles,
    decisionRoles: intent.decisionRoles,
  });

  const now = new Date();
  const targetCount = intent.objective.targetCompanyCount;
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: {
      status: "DONE",
      completedAt: now,
      costUsd: report.costUsd,
      output: {
        missionState: report.missionState,
        missionPhase: "EXECUTING",
        companiesTargeted: report.companiesCreated,
        leadsCreated: 0,
        opportunitiesCreated: 0,
        sequencesPlanned: 0,
        draftsAwaitingApproval: 0,
        costUsdSoFar: report.costUsd,
        objectiveProgress: {
          type: "companies_found",
          target: targetCount,
          unit: "empresas",
          current: report.companiesCreated,
          percentComplete: targetCount ? Math.min(100, Math.round((report.companiesCreated / targetCount) * 100)) : null,
          rawText: intent.objective.rawText,
        },
        progressUpdatedAt: now.toISOString(),
        error: null,
        appliedRestrictions: restrictions,
        restrictionNotes,
        // F7.3: nunca se narra un Executive Report vía LLM en esta fase —
        // el reporte estructurado real vive en discoveryExecution.
        report: null,
        contactCoverage: null,
        ceoIntent: intent,
        missionPlan: plan,
        ceoIntentMeta: {
          schemaVersion: CEO_INTENT_SCHEMA_VERSION,
          taxonomyVersion: BUSINESS_TAXONOMY_VERSION,
          plannerVersion: MISSION_PLANNER_VERSION,
          createdAt: now.toISOString(),
          warnings: intent.ambiguities,
        },
        discoveryExecution: report,
      } as never,
    },
  });

  log(missionTaskId, "dynamic discovery mission finished", {
    missionState: report.missionState,
    companiesCreated: report.companiesCreated,
    stopReason: report.stopReason,
  });
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

  // Bugfix real (misión atascada en RUNNING para siempre, 0 companies/
  // leads/opportunities/costo): interpretDailyDirective es una llamada
  // real a OpenAI (AgentRuntime.run() -> tool.execute(), que nunca
  // atrapa nada) awaited de forma SÍNCRONA acá, ANTES de que exista
  // runMissionPipelineAsync() -- la única función que tenía un .catch()
  // que marca la misión FAILED. Si esta llamada falla (API key
  // ausente/inválida, rate limit, timeout de red, o una respuesta del
  // LLM que no pasa el Zod.parse de interpretBusinessIntent), la
  // excepción subía sin capturar hasta el router, que solo devolvía un
  // error HTTP al cliente -- pero el AgentTask ya había quedado en
  // status=RUNNING en la línea de arriba, y como runMissionPipelineAsync()
  // nunca llegaba a dispararse, quedaba huérfano para siempre, bloqueando
  // además "una misión por día" (líneas 638-646) hasta una corrección manual
  // en la base. Mismo criterio de failMission() que runMissionPipelineAsync
  // ya usa para sus propios errores -- acá se aplica también a esta
  // ventana síncrona, la única que faltaba cubrir.
  try {
    const interpreted = (await runCeoToolDirectly(task.id, "interpretDailyDirective", {
      rawInstruction: instruction,
    })) as InterpretDailyDirectiveResult;

    // Corrección estructural: se calculan acá también (no solo dentro de
    // runMissionPipeline, que corre async) para que la respuesta síncrona
    // de POST /missions ya las muestre — sin esto, un cliente que lea la
    // respuesta inmediata del POST vería appliedRestrictions=null aunque
    // la instrucción sí las haya pedido.
    const initialRestrictions = interpreted.missionRestrictions ?? DEFAULT_MISSION_RESTRICTIONS;
    const initialRestrictionNotes = buildRestrictionNotes(initialRestrictions);

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
          appliedRestrictions: initialRestrictions,
          restrictionNotes: initialRestrictionNotes,
        } as never,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido interpretando la instrucción de la misión";
    log(task.id, "mission failed before pipeline start", { error: message });
    await failMission(task.id, message).catch((failErr) => {
      console.error(`[mission-orchestrator] could not even mark mission ${task.id} as FAILED:`, failErr);
    });
    throw err;
  }

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
  const contactCoverage = await computeContactCoverage(missionTaskId);
  const existing = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId }, select: { output: true } });
  const existingOutput = (existing?.output ?? {}) as Partial<MissionOutput>;

  // Corrección estructural (misión Iowa, 2026-07-13): antes esto era
  // SIEMPRE "COMPLETED", sin importar si la misión encontró lo que se le
  // pidió. Una misión que buscó contactos y terminó con empresas sin
  // ningún punto de contacto (ni Contact nombrado ni email
  // organizacional) es un resultado parcial, no un éxito total — se
  // marca PARTIAL, con contactCoverage explicando exactamente qué faltó
  // y por qué (proveedores omitidos, créditos agotados, etc.), nunca
  // presentado como éxito sin explicación.
  const missionState: MissionState =
    contactCoverage.companiesConsidered > 0 && contactCoverage.companiesWithoutContactPoint > 0
      ? "PARTIAL"
      : "COMPLETED";

  const output: MissionOutput = {
    missionState,
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
    appliedRestrictions: existingOutput.appliedRestrictions,
    restrictionNotes: existingOutput.restrictionNotes,
    contactCoverage,
    discoveryFallback: existingOutput.discoveryFallback,
  };

  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "DONE", completedAt: new Date(), output: output as never },
  });
  log(missionTaskId, "mission closed", { missionState, contactCoverage });
}

