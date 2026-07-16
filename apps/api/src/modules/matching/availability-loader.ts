// F6.2: adapter que carga desde Prisma los datos que necesita
// evaluateWorkerAvailability() — el único archivo de este par que
// importa Prisma. Usa scopedDb (nunca el cliente base): Worker/JobOrder/
// Assignment están en STRICT_TENANT_MODELS (ver core/tenancy/
// prisma-extension.ts), así que cada consulta ya viene automáticamente
// acotada al tenant de la request actual — un Worker/JobOrder/Assignment
// de otro tenant simplemente no existe para esta consulta (findUnique se
// reescribe a findFirst con tenantId inyectado). Nunca se acepta un
// tenantId por parámetro ni por body.

import { scopedDb } from "../../core/tenancy/prisma-extension";
import { evaluateWorkerAvailability, type AssignmentForAvailability } from "./availability";
import type { WorkerAvailabilityResult } from "@ai-staffing-os/shared";

export interface WorkerAvailabilityContext {
  workerId: string;
  workerStatus: string;
  assignments: AssignmentForAvailability[];
  jobOrderStartDate: Date;
  jobOrderEndDate: Date | null;
}

/**
 * Devuelve null si el Worker o el Job Order no existen (o pertenecen a
 * otro tenant, indistinguible por diseño) — el llamador decide cómo
 * reportar ese caso, esta función solo carga datos, no evalúa nada.
 */
export async function loadWorkerAvailabilityContext(
  workerId: string,
  jobOrderId: string,
): Promise<WorkerAvailabilityContext | null> {
  const [worker, jobOrder] = await Promise.all([
    scopedDb.worker.findUnique({ where: { id: workerId }, select: { id: true, status: true } }),
    scopedDb.jobOrder.findUnique({ where: { id: jobOrderId }, select: { id: true, startDate: true, endDate: true } }),
  ]);
  if (!worker || !jobOrder) return null;

  const assignments = await scopedDb.assignment.findMany({
    where: { workerId },
    select: { id: true, status: true, startDate: true, endDate: true },
  });

  return {
    workerId: worker.id,
    workerStatus: worker.status,
    assignments,
    jobOrderStartDate: jobOrder.startDate,
    jobOrderEndDate: jobOrder.endDate,
  };
}

/**
 * Conveniencia end-to-end (carga + evalúa) para el uso más común — sigue
 * siendo de solo lectura, cero escrituras, cero AgentTask, cero costo.
 */
export async function evaluateWorkerAvailabilityById(
  workerId: string,
  jobOrderId: string,
): Promise<WorkerAvailabilityResult | null> {
  const context = await loadWorkerAvailabilityContext(workerId, jobOrderId);
  if (!context) return null;
  return evaluateWorkerAvailability(context);
}
