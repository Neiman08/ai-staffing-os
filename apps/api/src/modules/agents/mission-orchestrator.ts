import type { AgentTaskDetail, MissionState } from "@ai-staffing-os/shared";
import type { InterpretDailyDirectiveResult } from "@ai-staffing-os/agents";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { createAndRunTaskSync, createQueuedTask, runCeoToolDirectly, toAgentTaskDetail } from "./task-executor";
import { computeMissionProgress } from "./tools/ceo-tools.impl";

// F4 addendum: tope general por misión, independiente del desiredVolume
// interpretado — mismo espíritu que el tope de 15/corrida de F3 y el de
// 50/corrida de selectTargetCompanies (F4 §11).
const MAX_COMPANIES_PER_MISSION = 50;
const DEFAULT_DAILY_MISSION_BUDGET_USD = 3;

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
}

async function getMissionBudgetStatus(tenantId: string, missionTaskId: string) {
  const tenant = await scopedDb.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings ?? {}) as { dailyMissionBudgetUsd?: number };
  const budgetUsd = settings.dailyMissionBudgetUsd ?? DEFAULT_DAILY_MISSION_BUDGET_USD;
  const progress = await computeMissionProgress(missionTaskId);
  return { spentUsd: progress.costUsdSoFar, budgetUsd, exceeded: progress.costUsdSoFar >= budgetUsd };
}

async function syncMissionOutput(missionTaskId: string, missionState: MissionState): Promise<void> {
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
  };
  await scopedDb.agentTask.update({ where: { id: missionTaskId }, data: { output: output as never } });
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

  const industries = interpreted.industryNames?.length
    ? await scopedDb.industry.findMany({ where: { name: { in: interpreted.industryNames } } })
    : [];
  const categories = interpreted.categoryNames?.length
    ? await scopedDb.jobCategory.findMany({ where: { name: { in: interpreted.categoryNames } } })
    : [];
  const categoryIds = categories.map((c) => c.id);

  const industryTargets: Array<{ id: string; name: string } | null> = industries.length > 0 ? industries : [null];
  const perCampaignVolume = Math.min(interpreted.desiredVolume ?? MAX_COMPANIES_PER_MISSION, MAX_COMPANIES_PER_MISSION);

  for (const industry of industryTargets) {
    if ((await getMissionBudgetStatus(tenantId, missionTaskId)).exceeded) {
      await syncMissionOutput(missionTaskId, "PAUSED_BUDGET");
      return;
    }

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
      if ((await getMissionBudgetStatus(tenantId, missionTaskId)).exceeded) {
        await syncMissionOutput(missionTaskId, "PAUSED_BUDGET");
        return;
      }

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
          await createAndRunTaskSync(tenantId, operatorUserId, {
            agentKey: "sales",
            type: "create_opportunity",
            input: { leadId },
            triggeredBy: "AGENT",
            parentTaskId: missionTaskId,
          });
        }
      }

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

      if ((await getMissionBudgetStatus(tenantId, missionTaskId)).exceeded) {
        await syncMissionOutput(missionTaskId, "PAUSED_BUDGET");
        return;
      }

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

  await syncMissionOutput(missionTaskId, "RUNNING");
}

function runMissionPipelineAsync(missionTaskId: string, tenantId: string, operatorUserId: string): void {
  runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, () =>
    runMissionPipeline(missionTaskId, tenantId, operatorUserId),
  ).catch((err) => {
    console.error(`[mission-orchestrator] pipeline failed for mission ${missionTaskId}:`, err);
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
  // AgentTask.status se queda en RUNNING para una misión cancelada (no
  // se ensancha AgentTaskStatus, ver el addendum) — "cancelada" vive en
  // output.missionState. Por eso el chequeo de "una misión por día" se
  // resuelve en código, no en el where de Prisma: una misión CANCELLED
  // no debe bloquear una nueva.
  const runningToday = await scopedDb.agentTask.findMany({
    where: { type: "daily_revenue_mission", status: "RUNNING", createdAt: { gte: todayStart } },
  });
  const existingActive = runningToday.find(
    (t) => ((t.output as { missionState?: string } | null)?.missionState ?? "RUNNING") !== "CANCELLED",
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
      } as never,
    },
  });

  runMissionPipelineAsync(task.id, ctx.tenantId, ctx.userId);

  return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: task.id } }));
}

/** PATCH /missions/:id — pausar/reanudar/cancelar/cerrar ahora. */
export async function applyMissionAction(
  missionTaskId: string,
  action: "pause" | "resume" | "cancel" | "close_now",
): Promise<AgentTaskDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const task = await scopedDb.agentTask.findUnique({ where: { id: missionTaskId } });
  if (!task || task.type !== "daily_revenue_mission") throw AppError.notFound("Mission not found");

  if (action === "close_now") {
    await closeMission(missionTaskId);
    return toAgentTaskDetail(await scopedDb.agentTask.findUniqueOrThrow({ where: { id: missionTaskId } }));
  }

  const nextState: MissionState = action === "pause" ? "PAUSED_BY_USER" : action === "resume" ? "RUNNING" : "CANCELLED";
  const currentOutput = (task.output ?? {}) as unknown as MissionOutput;
  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { output: { ...currentOutput, missionState: nextState } as never },
  });

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
  };

  await scopedDb.agentTask.update({
    where: { id: missionTaskId },
    data: { status: "DONE", completedAt: new Date(), output: output as never },
  });
}

