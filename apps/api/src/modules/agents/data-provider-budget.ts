import { scopedDb } from "../../core/tenancy/prisma-extension";

/**
 * F4.5/F4.6: presupuesto de proveedores de DATOS (Google Places, People
 * Data Labs), separado del presupuesto de IA (budget.ts, aiMonthlyBudgetUsd)
 * — mismo motivo que documenta docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md
 * §2: "no mezclar ambos guardias". Se suma solo el costUsd de AgentTask
 * cuyo type es discover_companies o find_contacts (los únicos
 * consumidores de proveedores pagos hoy), no el costUsd de toda la
 * cuenta — así un mes con mucho gasto de LLM no dispara falsamente este
 * guardia, y viceversa. Un solo presupuesto para los dos: ambos son
 * "gasto de enriquecimiento de datos", no vale la pena un guardia por
 * proveedor individual todavía.
 */
const DEFAULT_DATA_PROVIDER_BUDGET_USD = 10;
const DATA_PROVIDER_TASK_TYPES = ["discover_companies", "find_contacts"] as const;

export interface DataProviderBudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  exceeded: boolean;
}

export async function getDataProviderBudgetStatus(tenantId: string): Promise<DataProviderBudgetStatus> {
  const tenant = await scopedDb.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings ?? {}) as { dataProviderBudgetUsd?: number };
  const budgetUsd = settings.dataProviderBudgetUsd ?? DEFAULT_DATA_PROVIDER_BUDGET_USD;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const agg = await scopedDb.agentTask.aggregate({
    where: { type: { in: [...DATA_PROVIDER_TASK_TYPES] }, createdAt: { gte: startOfMonth } },
    _sum: { costUsd: true },
  });
  const spentUsd = Number(agg._sum.costUsd ?? 0);

  return { spentUsd, budgetUsd, exceeded: spentUsd >= budgetUsd };
}
