import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { createAndRunTaskSync } from "./task-executor";
import { getMonthlyBudgetStatus } from "./budget";
import { getStaleProcessedCompanyIds, getUnprocessedCompanyIds } from "./memory";
import { closeMission, recoverStuckMission, getMissionSettings } from "./mission-orchestrator";

/**
 * F3 §6: scheduler in-process, sin Redis/BullMQ. Un tick liviano corre
 * cada TICK_INTERVAL_MS y solo dispara una corrida completa por tenant
 * cuando ya pasó SWEEP_INTERVAL_HOURS desde la última — así el tick
 * puede ser frecuente (útil para pruebas/demo) sin gastar presupuesto de
 * más. Limitación consciente: en un entorno multi-instancia esto
 * correría duplicado por proceso — aceptable al volumen actual de un
 * solo proceso Node (mismo trade-off que el task-runner de F2).
 */
const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_SWEEP_INTERVAL_HOURS = 6; // aprobado
const MAX_COMPANIES_PER_SWEEP = 15; // aprobado
const STALE_SCORE_DAYS = 14;
const INACTIVITY_DAYS = 21;
const MAX_SEQUENCE_STEPS_PER_TICK = 30; // F4 §14

const operatorCache = new Map<string, string>(); // tenantId -> userId

async function getOperatorUserId(tenantId: string): Promise<string | null> {
  const cached = operatorCache.get(tenantId);
  if (cached) return cached;

  // No hay un humano "disparando" una corrida programada — se resuelve un
  // operador nominal (primer CEO/Admin activo) solo para satisfacer
  // TenancyContext.userId. La atribución real de cada escritura sigue
  // yendo al AgentInstance vía actor:{type:"AGENT"} (F2), nunca a este
  // usuario.
  const user = await prisma.user.findFirst({
    where: { tenantId, isActive: true, role: { name: { in: ["CEO", "Admin"] } } },
    orderBy: { createdAt: "asc" },
  });
  if (!user) return null;

  operatorCache.set(tenantId, user.id);
  return user.id;
}

interface TenantSweepSettings {
  lastProspectingSweepAt?: string;
  prospectingSweepIntervalHours?: number;
}

function isSweepDue(settings: TenantSweepSettings): boolean {
  const intervalHours = settings.prospectingSweepIntervalHours ?? DEFAULT_SWEEP_INTERVAL_HOURS;
  if (!settings.lastProspectingSweepAt) return true;
  const last = new Date(settings.lastProspectingSweepAt);
  return Date.now() - last.getTime() >= intervalHours * 60 * 60 * 1000;
}

async function markSweepRun(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settings: { ...settings, lastProspectingSweepAt: new Date().toISOString() } },
  });
}

export interface SweepResult {
  processed: number;
  rescored: number;
  followUpsCreated: number;
  budgetExceededMidSweep: boolean;
}

/**
 * Una corrida completa para un tenant: (1) procesa empresas importadas
 * sin analizar, (2) recalcula score de empresas con más de
 * STALE_SCORE_DAYS desde el último análisis, (3) detecta leads inactivos
 * y les crea un follow-up de re-enganche. Cada sub-paso vuelve a chequear
 * el presupuesto — si se agota a mitad de la corrida, el resto se corta
 * ahí, no se fuerza (F3 §6).
 */
export async function runProspectingSweep(tenantId: string): Promise<SweepResult> {
  const operatorUserId = await getOperatorUserId(tenantId);
  if (!operatorUserId) {
    return { processed: 0, rescored: 0, followUpsCreated: 0, budgetExceededMidSweep: false };
  }

  return runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, async () => {
    const result: SweepResult = { processed: 0, rescored: 0, followUpsCreated: 0, budgetExceededMidSweep: false };

    const initialBudget = await getMonthlyBudgetStatus(tenantId);
    if (initialBudget.exceeded) {
      result.budgetExceededMidSweep = true;
      await markSweepRun(tenantId);
      return result;
    }

    // 1. empresas importadas sin analizar todavía
    const unprocessed = await getUnprocessedCompanyIds(MAX_COMPANIES_PER_SWEEP);
    for (const companyId of unprocessed) {
      if ((await getMonthlyBudgetStatus(tenantId)).exceeded) {
        result.budgetExceededMidSweep = true;
        break;
      }
      await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "prospecting",
        type: "process_company_pipeline",
        input: { companyId },
        triggeredBy: "SCHEDULE",
      });
      result.processed += 1;
    }

    // 2. recalcular score de empresas con análisis viejo
    if (!result.budgetExceededMidSweep) {
      const stale = await getStaleProcessedCompanyIds(STALE_SCORE_DAYS, MAX_COMPANIES_PER_SWEEP);
      for (const companyId of stale) {
        if ((await getMonthlyBudgetStatus(tenantId)).exceeded) {
          result.budgetExceededMidSweep = true;
          break;
        }
        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "sales",
          type: "score_company",
          input: { companyId },
          triggeredBy: "SCHEDULE",
        });
        result.rescored += 1;
      }
    }

    // 3. leads inactivos -> follow-up de re-enganche (si no tienen uno pendiente ya)
    if (!result.budgetExceededMidSweep) {
      const inactivityCutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
      const staleLeads = await scopedDb.lead.findMany({
        where: { status: { in: ["NEW", "CONTACTED", "INTERESTED"] }, updatedAt: { lt: inactivityCutoff } },
        take: MAX_COMPANIES_PER_SWEEP,
        select: { id: true },
      });

      for (const lead of staleLeads) {
        const hasPending = await scopedDb.followUp.findFirst({
          where: { entityType: "lead", entityId: lead.id, status: "PENDING" },
        });
        if (hasPending) continue;

        await createAndRunTaskSync(tenantId, operatorUserId, {
          agentKey: "sales",
          type: "create_follow_up",
          input: { entityType: "lead", entityId: lead.id },
          triggeredBy: "SCHEDULE",
        });
        result.followUpsCreated += 1;
      }
    }

    await markSweepRun(tenantId);
    return result;
  });
}

export interface CampaignSequenceSweepResult {
  messagesPersonalized: number;
  budgetExceededMidSweep: boolean;
}

/**
 * F4 §14: revisa, en CADA tick (no gateado por el intervalo de 6h de
 * arriba — es una consulta barata, solo actúa cuando algo realmente está
 * vencido), los FollowUp de secuencia de campaña con dueDate <= hoy y
 * status PENDING. Un FollowUp cuya CampaignCompany ya recibió una
 * intención clasificada nunca llega hasta acá — suggestNextStep ya
 * canceló el resto de su secuencia (outreach-tools.impl.ts), así que
 * esta consulta por sí sola respeta esa decisión sin necesitar chequear
 * lastIntent de nuevo.
 */
export async function runCampaignSequenceSweep(tenantId: string): Promise<CampaignSequenceSweepResult> {
  const operatorUserId = await getOperatorUserId(tenantId);
  if (!operatorUserId) return { messagesPersonalized: 0, budgetExceededMidSweep: false };

  return runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, async () => {
    const result: CampaignSequenceSweepResult = { messagesPersonalized: 0, budgetExceededMidSweep: false };

    const dueFollowUps = await scopedDb.followUp.findMany({
      where: { campaignId: { not: null }, status: "PENDING", dueDate: { lte: new Date() } },
      take: MAX_SEQUENCE_STEPS_PER_TICK,
    });

    for (const followUp of dueFollowUps) {
      if ((await getMonthlyBudgetStatus(tenantId)).exceeded) {
        result.budgetExceededMidSweep = true;
        break;
      }

      const cc = await scopedDb.campaignCompany.findFirst({
        where: { campaignId: followUp.campaignId!, companyId: followUp.entityId },
      });
      if (!cc) continue;

      const sequence = await scopedDb.followUp.findMany({
        where: { campaignId: followUp.campaignId!, entityType: "company", entityId: followUp.entityId },
        orderBy: { dueDate: "asc" },
      });
      const step = sequence.findIndex((f) => f.id === followUp.id);
      if (step === -1) continue;

      await createAndRunTaskSync(tenantId, operatorUserId, {
        agentKey: "outreach",
        type: "personalize_message",
        input: { campaignCompanyId: cc.id, step },
        triggeredBy: "SCHEDULE",
      });
      result.messagesPersonalized += 1;
    }

    return result;
  });
}

export interface MissionCloseSweepResult {
  closed: number;
  recovered: number;
}

/**
 * F4 addendum + bugfix de ciclo de vida (misión atascada en RUNNING para
 * siempre): dos chequeos independientes en cada tick.
 *
 * 1. Cierra (Executive Report real) cualquier Daily Revenue Mission que
 *    siga RUNNING desde un día calendario anterior — sin esperar a que
 *    un humano pida el cierre manual.
 * 2. Watchdog same-day: una misión RUNNING de HOY cuyo heartbeat
 *    (progressUpdatedAt) no se movió en más de missionStaleMinutes se
 *    recupera como FAILED — antes esto no se detectaba nunca en el
 *    mismo día calendario, solo al cruzar la medianoche, por eso una
 *    misión podía quedar visiblemente atascada horas enteras aunque el
 *    pipeline ya hubiera terminado (o colgado) hacía rato.
 */
export async function runMissionCloseSweep(tenantId: string): Promise<MissionCloseSweepResult> {
  const operatorUserId = await getOperatorUserId(tenantId);
  if (!operatorUserId) return { closed: 0, recovered: 0 };

  return runWithTenancyContext({ tenantId, userId: operatorUserId, permissions: [] }, async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const staleFromYesterday = await scopedDb.agentTask.findMany({
      where: { type: "daily_revenue_mission", status: "RUNNING", createdAt: { lt: todayStart } },
    });
    for (const mission of staleFromYesterday) {
      await closeMission(mission.id);
    }

    const { staleMinutes } = await getMissionSettings(tenantId);
    const staleThreshold = new Date(Date.now() - staleMinutes * 60_000);

    const runningToday = await scopedDb.agentTask.findMany({
      where: { type: "daily_revenue_mission", status: "RUNNING", createdAt: { gte: todayStart } },
    });
    const stuckToday = runningToday.filter((m) => {
      const output = m.output as { missionState?: string; progressUpdatedAt?: string } | null;
      // F12.5: output=null (nunca se llegó a escribir NINGÚN output, ver
      // el bugfix real de F12.3 en launchMission -- una excepción en la
      // ventana síncrona entre status="RUNNING" y el primer
      // syncMissionOutput dejaba exactamente esta forma) cuenta como
      // atascada igual que missionState="RUNNING" -- antes, `undefined
      // !== "RUNNING"` hacía que este caso nunca calificara para el
      // watchdog, la única red de seguridad que existía para una misión
      // sin actividad. PAUSED_*/CANCELLED/COMPLETED/FAILED (un
      // missionState real y distinto de "RUNNING") siguen sin ser
      // "atascadas" -- esas SÍ tienen output, solo que en un estado
      // terminal/pausado legítimo.
      if (output !== null && output?.missionState !== "RUNNING") return false;
      const lastProgress = output?.progressUpdatedAt ? new Date(output.progressUpdatedAt) : m.createdAt;
      return lastProgress < staleThreshold;
    });
    for (const mission of stuckToday) {
      await recoverStuckMission(
        mission.id,
        `Watchdog: sin actividad por más de ${staleMinutes} minutos — recuperada automáticamente.`,
      );
    }

    return { closed: staleFromYesterday.length, recovered: stuckToday.length };
  });
}

export async function tickAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });

  for (const tenant of tenants) {
    try {
      const sequenceResult = await runCampaignSequenceSweep(tenant.id);
      if (sequenceResult.messagesPersonalized > 0) {
        console.log(`[scheduler] campaign sequence sweep for tenant ${tenant.id}:`, sequenceResult);
      }
    } catch (err) {
      console.error(`[scheduler] campaign sequence sweep failed for tenant ${tenant.id}:`, err);
    }

    try {
      const closeResult = await runMissionCloseSweep(tenant.id);
      if (closeResult.closed > 0 || closeResult.recovered > 0) {
        console.log(`[scheduler] mission close sweep for tenant ${tenant.id}:`, closeResult);
      }
    } catch (err) {
      console.error(`[scheduler] mission close sweep failed for tenant ${tenant.id}:`, err);
    }

    const settings = (tenant.settings ?? {}) as TenantSweepSettings;
    if (!isSweepDue(settings)) continue;

    try {
      const result = await runProspectingSweep(tenant.id);
      console.log(`[scheduler] sweep for tenant ${tenant.id}:`, result);
    } catch (err) {
      console.error(`[scheduler] sweep failed for tenant ${tenant.id}:`, err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startProspectingScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tickAllTenants().catch((err) => console.error("[scheduler] tick failed:", err));
  }, TICK_INTERVAL_MS);
  // No corre inmediatamente al arrancar — evita gastar presupuesto en
  // cada reinicio del proceso durante desarrollo.
}

export function stopProspectingScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
