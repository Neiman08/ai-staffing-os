import { scopedDb } from "../../core/tenancy/prisma-extension";

// F2 §16: presupuesto de referencia aprobado si el tenant no configuró uno
// propio en Tenant.settings.aiMonthlyBudgetUsd.
const DEFAULT_BUDGET_USD = 50;

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  exceeded: boolean;
}

/**
 * Suma el costo de todos los AgentTask del tenant creados desde el inicio
 * del mes calendario actual (UTC) y lo compara contra el presupuesto
 * configurado. Debe llamarse ANTES de invocar al LLM — nunca después
 * (F2 §16: "si el presupuesto se supera, debe bloquear nuevas llamadas").
 */
export async function getMonthlyBudgetStatus(tenantId: string): Promise<BudgetStatus> {
  const tenant = await scopedDb.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings ?? {}) as { aiMonthlyBudgetUsd?: number };
  const budgetUsd = settings.aiMonthlyBudgetUsd ?? DEFAULT_BUDGET_USD;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const agg = await scopedDb.agentTask.aggregate({
    where: { createdAt: { gte: startOfMonth } },
    _sum: { costUsd: true },
  });
  const spentUsd = Number(agg._sum.costUsd ?? 0);

  return { spentUsd, budgetUsd, exceeded: spentUsd >= budgetUsd };
}
