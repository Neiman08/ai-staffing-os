import { scopedDb } from "../../core/tenancy/prisma-extension";
import { env } from "../../core/env";

/**
 * F27 Fase 6 (hallazgo real de esta misión: un HTTP 402 de People Data
 * Labs pese a que el panel real mostraba 15 créditos restantes -- una
 * sola Company con `targetRoles.length >= 5` ya pedía hasta 20 registros
 * en un solo Search, suficiente para agotar ese resto en UNA llamada).
 * `data-provider-budget.ts` (F4.5+) solo trackea el gasto ESTIMADO propio
 * en USD, nunca créditos reales de PDL, y no existe ningún techo por
 * misión ni por empresa -- este módulo agrega ambos, deliberadamente
 * conservador y por separado del guardia de USD (que sigue existiendo,
 * ver contact-enrichment.ts, ambos se respetan).
 *
 * El costo por match de PDL (COST_PER_MATCH_USD en people-data-labs.ts)
 * es la única fuente de costo real dentro de `find_contacts`
 * (Hunter.io cuesta $0 en este repo, ver hunter.ts) -- dividir el gasto
 * agregado de ese tipo de tarea por ese costo por match da el número real
 * de créditos de PDL consumidos este mes, sin necesitar una tabla nueva
 * ni otra llamada real a PDL para preguntarle su propio saldo.
 */
const COST_PER_MATCH_USD = 0.05; // debe reflejar el mismo valor real de people-data-labs.ts
const DATA_PROVIDER_TASK_TYPE = "find_contacts";

export interface PdlMonthlyBudgetStatus {
  creditsUsedThisMonth: number;
  monthlyCreditBudget: number;
  remainingThisMonth: number;
}

export async function getPdlMonthlyBudgetStatus(tenantId: string): Promise<PdlMonthlyBudgetStatus> {
  const monthlyCreditBudget = env.PDL_MONTHLY_CREDIT_BUDGET;
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const agg = await scopedDb.agentTask.aggregate({
    where: { tenantId, type: DATA_PROVIDER_TASK_TYPE, createdAt: { gte: startOfMonth } },
    _sum: { costUsd: true },
  });
  const spentUsd = Number(agg._sum.costUsd ?? 0);
  const creditsUsedThisMonth = Math.round(spentUsd / COST_PER_MATCH_USD);

  return { creditsUsedThisMonth, monthlyCreditBudget, remainingThisMonth: Math.max(0, monthlyCreditBudget - creditsUsedThisMonth) };
}

/**
 * Presupuesto de UNA misión -- objeto mutable simple, nunca persistido
 * (una misión corre en un solo proceso; no hace falta coordinación entre
 * procesos para este guardia específico, a diferencia del techo mensual
 * de arriba que sí debe sobrevivir entre misiones/procesos). Quien orquesta
 * el loop de empresas de una misión (mission-executor.ts) crea UNO antes
 * del loop y lo pasa a cada llamada de enrichCompanyWithDecisionContacts
 * -- así ninguna empresa individual puede gastar más de lo que le queda a
 * la misión completa, sin importar cuántos roles objetivo tenga.
 */
export interface PdlMissionBudget {
  remaining: number;
}

export function createPdlMissionBudget(missionCreditBudget: number = env.PDL_PER_MISSION_CREDIT_BUDGET): PdlMissionBudget {
  return { remaining: Math.max(0, missionCreditBudget) };
}

export function consumePdlMissionBudget(budget: PdlMissionBudget, credits: number): void {
  budget.remaining = Math.max(0, budget.remaining - Math.max(0, credits));
}

/**
 * Reduce el tamaño de búsqueda solicitado al mínimo real entre: lo que
 * pidió el llamador, el techo fijo por empresa, lo que le queda a ESTA
 * misión, y lo que le queda al mes completo -- nunca se le pide a PDL más
 * de lo que cualquiera de estos 4 límites permite. 0 significa "no llamar
 * a PDL en absoluto para esta empresa" (presupuesto agotado en algún nivel).
 */
export function computeAllowedPdlSearchSize(params: { requestedSize: number; missionBudget: PdlMissionBudget; monthlyRemaining: number }): number {
  return Math.max(0, Math.min(params.requestedSize, env.PDL_PER_COMPANY_MAX_RESULTS, params.missionBudget.remaining, params.monthlyRemaining));
}
