import { prisma } from "@ai-staffing-os/db";
import { flagOverdueInvoicesForTenant } from "./service";

/**
 * F5.8 (plan §10.3): mismo patrón in-process (setInterval, sin
 * Redis/BullMQ) que compliance/scheduler.ts — un escaneo determinista de
 * vencimientos, sin AgentTask/LLM involucrado, como scheduler propio y
 * separado.
 */
const TICK_INTERVAL_MS = 60 * 60 * 1000; // 60 min — vencimientos no son urgentes minuto a minuto

async function tickAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });

  for (const tenant of tenants) {
    try {
      const result = await flagOverdueInvoicesForTenant(tenant.id);
      if (result.flagged > 0) {
        console.log(`[billing-scheduler] sweep for tenant ${tenant.id}:`, result);
      }
    } catch (err) {
      console.error(`[billing-scheduler] sweep failed for tenant ${tenant.id}:`, err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startBillingOverdueScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tickAllTenants().catch((err) => console.error("[billing-scheduler] tick failed:", err));
  }, TICK_INTERVAL_MS);
  // No corre inmediatamente al arrancar — mismo criterio que agents/compliance.
}

export function stopBillingOverdueScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
