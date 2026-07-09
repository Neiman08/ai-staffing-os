import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { createAndRunTaskSync } from "./task-executor";
import { getMonthlyBudgetStatus } from "./budget";
import { getStaleProcessedCompanyIds, getUnprocessedCompanyIds } from "./memory";

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

export async function tickAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });

  for (const tenant of tenants) {
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
