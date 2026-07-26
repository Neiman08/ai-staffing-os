import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { env } from "../../core/env";
import { reconcileMailbox } from "./reconciliation";
import { resolveSender } from "./sender-profiles";

/**
 * F27 Fase 4 (bug real encontrado en auditoría de "primera misión
 * real"): reconcileMailbox() solo se disparaba manualmente vía POST
 * /emails/reconcile -- sin esto, un EmailMessage real que llega a
 * ACCEPTED_BY_PROVIDER se queda ahí para siempre (nunca SENT_CONFIRMED,
 * nunca BOUNCED, nunca DELIVERY_UNKNOWN) salvo que un humano recuerde
 * pedirlo a mano. El comentario original en email/router.ts decía
 * explícitamente "si se agrega más adelante, debe ser configurable,
 * apagada por defecto en tests, y con guarda de liderazgo de proceso" --
 * configurable vía env (degrada honesto si Graph no está configurado,
 * igual que el resto de este módulo), nunca corre en tests (estos
 * schedulers solo arrancan desde index.ts, nunca desde un test que
 * arma su propio `createApp()`), y no necesita liderazgo de proceso
 * porque reconcileMailbox ya es idempotente por diseño (ver su propio
 * docstring en reconciliation.ts) -- mismo trade-off de "un solo
 * proceso Node, sin Redis/BullMQ" que ya aceptan explícitamente
 * agents/scheduler.ts y billing/scheduler.ts.
 */
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 min -- la ventana de DELIVERY_UNKNOWN es de 48h, no hace falta más frecuente

const operatorCache = new Map<string, string>(); // tenantId -> userId, mismo criterio que agents/scheduler.ts

async function getOperatorUserId(tenantId: string): Promise<string | null> {
  const cached = operatorCache.get(tenantId);
  if (cached) return cached;

  // No hay un humano disparando esta corrida -- se resuelve un operador
  // nominal (primer CEO/Admin activo) solo para satisfacer
  // TenancyContext.userId y que logAuditEvent (dentro de
  // reconcileMailbox) tenga un actorId real y resoluble.
  const user = await prisma.user.findFirst({
    where: { tenantId, isActive: true, role: { name: { in: ["CEO", "Admin"] } } },
    orderBy: { createdAt: "asc" },
  });
  if (!user) return null;

  operatorCache.set(tenantId, user.id);
  return user.id;
}

async function tickAllTenants(): Promise<void> {
  if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) return; // Graph no configurado -- degrada honesto
  const mailbox = resolveSender("commercial")?.email;
  if (!mailbox) return;
  const creds = { tenantId: env.AZURE_TENANT_ID, clientId: env.AZURE_CLIENT_ID, clientSecret: env.AZURE_CLIENT_SECRET };

  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  for (const tenant of tenants) {
    const operatorUserId = await getOperatorUserId(tenant.id);
    if (!operatorUserId) continue;

    try {
      const summary = await runWithTenancyContext({ tenantId: tenant.id, userId: operatorUserId, permissions: [] }, () => reconcileMailbox(mailbox, creds));
      if (summary.confirmedThisRun > 0 || summary.bounced > 0 || summary.untrackedAlertsCreated > 0 || summary.markedDeliveryUnknown > 0) {
        console.log(`[email-reconciliation-scheduler] sweep for tenant ${tenant.id}:`, summary);
      }
    } catch (err) {
      console.error(`[email-reconciliation-scheduler] sweep failed for tenant ${tenant.id}:`, err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startEmailReconciliationScheduler(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tickAllTenants().catch((err) => console.error("[email-reconciliation-scheduler] tick failed:", err));
  }, TICK_INTERVAL_MS);
  // No corre inmediatamente al arrancar -- mismo criterio que el resto de los schedulers.
}

export function stopEmailReconciliationScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
