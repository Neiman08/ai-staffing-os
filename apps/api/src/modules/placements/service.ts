/**
 * F9.4: Placement -- wiring impuro entre
 * `operations-intelligence/placement.ts` (puro) y los datos reales del
 * tenant. `Placement` es la transición APROBADA entre reclutamiento y
 * operaciones -- exige una `PlacementReadiness` YA evaluada (F8.10,
 * consumida como señal, nunca recalculada). Nunca se activa
 * automáticamente, nunca infiere payRate/billRate.
 */
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import {
  checkPlacementTransition,
  isValidPlacementTransition,
  type PlacementStatus,
  type PlacementReadinessStatusLike,
} from "../operations-intelligence/placement";

export interface CreatePlacementInput {
  candidateId: string;
  jobOrderId: string;
  payRate?: number | null;
  billRate?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  shiftType?: string | null;
  notes?: string | null;
}

export interface PlacementRecord {
  id: string;
  candidateId: string;
  workerId: string | null;
  companyId: string;
  jobOrderId: string;
  payRate: string | null;
  billRate: string | null;
  startDate: string | null;
  endDate: string | null;
  shiftType: string | null;
  status: PlacementStatus;
  blockers: string[];
  warnings: string[];
  approverId: string | null;
  approvedAt: string | null;
  notes: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPlacementRecord(record: {
  id: string;
  candidateId: string;
  workerId: string | null;
  companyId: string;
  jobOrderId: string;
  payRate: { toString(): string } | null;
  billRate: { toString(): string } | null;
  startDate: Date | null;
  endDate: Date | null;
  shiftType: string | null;
  status: string;
  blockers: string[];
  warnings: string[];
  approverId: string | null;
  approvedAt: Date | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PlacementRecord {
  return {
    id: record.id,
    candidateId: record.candidateId,
    workerId: record.workerId,
    companyId: record.companyId,
    jobOrderId: record.jobOrderId,
    payRate: record.payRate?.toString() ?? null,
    billRate: record.billRate?.toString() ?? null,
    startDate: record.startDate?.toISOString() ?? null,
    endDate: record.endDate?.toISOString() ?? null,
    shiftType: record.shiftType,
    status: record.status as PlacementStatus,
    blockers: record.blockers,
    warnings: record.warnings,
    approverId: record.approverId,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    notes: record.notes,
    createdById: record.createdById,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Blockers/warnings informativos: siempre evaluados contra el primer gate real (PENDING_APPROVAL), independientemente del status actual -- muestran qué falta para avanzar. */
async function computeDisplaySignals(
  candidateId: string,
  jobOrderId: string,
  payRate: number | null,
  billRate: number | null,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const readiness = await scopedDb.placementReadiness.findFirst({
    where: { candidateId, jobOrderId },
    select: { readinessStatus: true },
  });
  const readinessStatus = (readiness?.readinessStatus as PlacementReadinessStatusLike | undefined) ?? "NOT_READY";
  const result = checkPlacementTransition({ targetStatus: "PENDING_APPROVAL", payRate, billRate, placementReadinessStatus: readinessStatus });
  return { blockers: result.blockers, warnings: result.warnings };
}

/**
 * F9.4: crea (idempotente) un Placement en DRAFT -- exige una
 * `PlacementReadiness` YA evaluada para el mismo par (400 si no
 * existe). Nunca infiere payRate/billRate: si el caller no los manda,
 * quedan `null` y el registro nace con un blocker explícito. Si el
 * Candidate ya tiene un Worker (F5.2), se enlaza automáticamente --
 * nunca se crea uno nuevo acá.
 */
export async function createPlacement(input: CreatePlacementInput): Promise<PlacementRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.placement.findFirst({ where: { candidateId: input.candidateId, jobOrderId: input.jobOrderId } });
  if (existing) return toPlacementRecord(existing);

  const [candidate, jobOrder, readiness] = await Promise.all([
    scopedDb.candidate.findUnique({ where: { id: input.candidateId }, include: { worker: true } }),
    scopedDb.jobOrder.findUnique({ where: { id: input.jobOrderId } }),
    scopedDb.placementReadiness.findFirst({ where: { candidateId: input.candidateId, jobOrderId: input.jobOrderId } }),
  ]);
  if (!candidate) throw AppError.notFound("Candidate not found");
  if (!jobOrder) throw AppError.notFound("Job Order not found");
  if (!readiness) {
    throw AppError.badRequest("No Placement Readiness evaluation found for this candidate and job order -- run it first", {
      candidateId: input.candidateId,
      jobOrderId: input.jobOrderId,
    });
  }

  const payRate = input.payRate ?? null;
  const billRate = input.billRate ?? null;
  const { blockers, warnings } = await computeDisplaySignals(input.candidateId, input.jobOrderId, payRate, billRate);

  const record = await scopedDb.placement.create({
    data: {
      tenantId: ctx.tenantId,
      candidateId: input.candidateId,
      workerId: candidate.worker?.id ?? null,
      companyId: jobOrder.companyId,
      jobOrderId: input.jobOrderId,
      payRate: payRate ?? undefined,
      billRate: billRate ?? undefined,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      shiftType: (input.shiftType as never) ?? undefined,
      notes: input.notes ?? undefined,
      status: "DRAFT",
      blockers,
      warnings,
      createdById: ctx.userId,
    },
  });

  await logAuditEvent({
    action: "placement.created",
    entityType: "placement",
    entityId: record.id,
    after: { candidateId: input.candidateId, jobOrderId: input.jobOrderId, status: record.status },
  });

  return toPlacementRecord(record);
}

export async function getPlacement(candidateId: string, jobOrderId: string): Promise<PlacementRecord | null> {
  const record = await scopedDb.placement.findFirst({ where: { candidateId, jobOrderId } });
  if (!record) return null;
  return toPlacementRecord(record);
}

export async function getPlacementById(id: string): Promise<PlacementRecord> {
  const record = await scopedDb.placement.findUnique({ where: { id } });
  if (!record) throw AppError.notFound("Placement not found");
  return toPlacementRecord(record);
}

export interface UpdatePlacementInput {
  payRate?: number | null;
  billRate?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  shiftType?: string | null;
  notes?: string | null;
}

/**
 * Edita campos NO sensibles al estado (nunca status/candidateId/
 * jobOrderId/tenantId -- eso vive exclusivamente en `updatePlacementStatus`).
 * Recalcula blockers/warnings informativos tras el cambio.
 */
export async function updatePlacement(id: string, input: UpdatePlacementInput): Promise<PlacementRecord> {
  const existing = await scopedDb.placement.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Placement not found");

  const payRate = input.payRate !== undefined ? input.payRate : existing.payRate ? Number(existing.payRate) : null;
  const billRate = input.billRate !== undefined ? input.billRate : existing.billRate ? Number(existing.billRate) : null;
  const { blockers, warnings } = await computeDisplaySignals(existing.candidateId, existing.jobOrderId, payRate, billRate);

  const updated = await scopedDb.placement.update({
    where: { id },
    data: {
      payRate: input.payRate !== undefined ? (input.payRate ?? null) : undefined,
      billRate: input.billRate !== undefined ? (input.billRate ?? null) : undefined,
      startDate: input.startDate !== undefined ? (input.startDate ? new Date(input.startDate) : null) : undefined,
      endDate: input.endDate !== undefined ? (input.endDate ? new Date(input.endDate) : null) : undefined,
      shiftType: input.shiftType !== undefined ? ((input.shiftType as never) ?? null) : undefined,
      notes: input.notes !== undefined ? input.notes : undefined,
      blockers,
      warnings,
    },
  });

  await logAuditEvent({
    action: "placement.updated",
    entityType: "placement",
    entityId: id,
    after: { payRate: updated.payRate?.toString() ?? null, billRate: updated.billRate?.toString() ?? null },
  });

  return toPlacementRecord(updated);
}

/**
 * Único camino para cambiar `status` -- valida el grafo de transiciones
 * Y las reglas de negocio (`checkPlacementTransition`: compensación
 * explícita, Placement Readiness). `APPROVED` registra `approverId`/
 * `approvedAt` del contexto de tenancy, nunca del body. Nunca alcanza
 * `ACTIVE` salvo una llamada explícita separada -- este endpoint nunca
 * encadena transiciones automáticamente.
 */
export async function updatePlacementStatus(id: string, targetStatus: PlacementStatus): Promise<PlacementRecord> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.placement.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Placement not found");

  const currentStatus = existing.status as PlacementStatus;
  if (!isValidPlacementTransition(currentStatus, targetStatus)) {
    throw AppError.badRequest(`Invalid placement status transition: ${currentStatus} -> ${targetStatus}`);
  }

  const readiness = await scopedDb.placementReadiness.findFirst({
    where: { candidateId: existing.candidateId, jobOrderId: existing.jobOrderId },
    select: { readinessStatus: true },
  });
  const readinessStatus = (readiness?.readinessStatus as PlacementReadinessStatusLike | undefined) ?? "NOT_READY";
  const payRate = existing.payRate ? Number(existing.payRate) : null;
  const billRate = existing.billRate ? Number(existing.billRate) : null;

  const check = checkPlacementTransition({ targetStatus, payRate, billRate, placementReadinessStatus: readinessStatus });
  if (!check.allowed) {
    throw AppError.badRequest(`Cannot transition to ${targetStatus}: ${check.blockers.join(" ")}`, { blockers: check.blockers });
  }

  const updated = await scopedDb.placement.update({
    where: { id },
    data: {
      status: targetStatus,
      blockers: check.blockers,
      warnings: check.warnings,
      approverId: targetStatus === "APPROVED" ? ctx.userId : existing.approverId,
      approvedAt: targetStatus === "APPROVED" ? new Date() : existing.approvedAt,
    },
  });

  await logAuditEvent({
    action: "placement.status_changed",
    entityType: "placement",
    entityId: id,
    before: { status: currentStatus },
    after: { status: targetStatus },
  });

  return toPlacementRecord(updated);
}
