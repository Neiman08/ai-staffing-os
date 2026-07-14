import { prisma } from "@ai-staffing-os/db";
import { runComplianceAlertSweepForTenant } from "./service";

/**
 * F5.5 (plan §7.2, aprobado): "job diario/periódico... reutiliza el
 * mecanismo, no lo reinventa" — mismo patrón in-process de
 * modules/agents/scheduler.ts (setInterval, sin Redis/BullMQ), pero
 * como un scheduler propio y separado: este sweep es un escaneo
 * determinista de datos (vencimientos/requisitos), no involucra ningún
 * AgentTask/LLM, así que no pertenece dentro del módulo de agents.
 */
const TICK_INTERVAL_MS = 60 * 60 * 1000; // 60 min — vencimientos no son urgentes minuto a minuto

async function tickAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });

  for (const tenant of tenants) {
    try {
      const result = await runComplianceAlertSweepForTenant(tenant.id);
      if (result.expiring > 0 || result.expired > 0 || result.missing > 0) {
        console.log(`[compliance-scheduler] sweep for tenant ${tenant.id}:`, result);
      }
    } catch (err) {
      console.error(`[compliance-scheduler] sweep failed for tenant ${tenant.id}:`, err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startComplianceAlertScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tickAllTenants().catch((err) => console.error("[compliance-scheduler] tick failed:", err));
  }, TICK_INTERVAL_MS);
  // No corre inmediatamente al arrancar — mismo criterio que el
  // scheduler de agents (evita gastar ciclos en cada reinicio de dev).
}

export function stopComplianceAlertScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
