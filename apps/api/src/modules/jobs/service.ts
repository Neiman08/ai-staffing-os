import type {
  CreateJobOrderInput,
  JobOrderDetail,
  JobOrderListItem,
  JobOrderQuery,
  Paginated,
  UpdateJobOrderInput,
  UpdateJobOrderStatusInput,
} from "@ai-staffing-os/shared";
import { isValidJobOrderStatusTransition, JOB_ORDER_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { interpretJobIntake, type JobIntakeResult } from "../recruiting-intelligence/job-intake";

/**
 * F5.1: mismo shape { city, state, address } que el schema ya declaraba
 * desde F0 (JobOrder.location Json?) — nunca se inventó un formato nuevo.
 */
interface JobOrderLocationJson {
  address?: string;
  city: string;
  state: string;
}

function toLocationJson(location: JobOrderLocationJson | undefined): JobOrderLocationJson | undefined {
  if (!location) return undefined;
  return { address: location.address, city: location.city, state: location.state };
}

function readLocationJson(value: unknown): JobOrderLocationJson | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.city !== "string" || typeof v.state !== "string") return null;
  return { address: typeof v.address === "string" ? v.address : undefined, city: v.city, state: v.state };
}

/**
 * F5.1: valida que cada key de `requirements` sea un DocumentType real
 * (mismo patrón ya usado por el seed y por JobCategory.requiredCertifications
 * — un array de keys, nunca texto libre). scopedDb.documentType ya está en
 * HYBRID_GLOBAL_MODELS, así que la consulta ya respeta tenant+globales.
 */
async function assertValidRequirementKeys(requirements: string[] | undefined): Promise<void> {
  if (!requirements || requirements.length === 0) return;
  const unique = Array.from(new Set(requirements));
  const found = await scopedDb.documentType.findMany({ where: { key: { in: unique } } });
  if (found.length !== unique.length) {
    const foundKeys = new Set(found.map((d) => d.key));
    const invalid = unique.filter((k) => !foundKeys.has(k));
    throw AppError.badRequest(`Unknown document type key(s) in requirements: ${invalid.join(", ")}`, { invalid });
  }
}

function toListItem(jobOrder: {
  id: string;
  title: string;
  company: { name: string };
  category: { name: string };
  companyId: string;
  categoryId: string;
  status: string;
  workersNeeded: number;
  workersFilled: number;
  billRate: { toString(): string };
  payRate: { toString(): string };
  shiftType: string;
  urgency: string;
  startDate: Date;
  endDate: Date | null;
  createdAt: Date;
}): JobOrderListItem {
  return {
    id: jobOrder.id,
    title: jobOrder.title,
    companyId: jobOrder.companyId,
    companyName: jobOrder.company.name,
    categoryId: jobOrder.categoryId,
    categoryName: jobOrder.category.name,
    status: jobOrder.status as never,
    workersNeeded: jobOrder.workersNeeded,
    workersFilled: jobOrder.workersFilled,
    billRate: jobOrder.billRate.toString(),
    payRate: jobOrder.payRate.toString(),
    shiftType: jobOrder.shiftType,
    urgency: jobOrder.urgency as never,
    startDate: jobOrder.startDate.toISOString(),
    endDate: jobOrder.endDate?.toISOString() ?? null,
    createdAt: jobOrder.createdAt.toISOString(),
  };
}

export async function listJobOrders(query: JobOrderQuery): Promise<Paginated<JobOrderListItem>> {
  const sortField = query.sortBy ?? "createdAt";
  const sortDir = query.sortDir ?? "desc";

  const rows = await scopedDb.jobOrder.findMany({
    ...buildCursorArgs({ cursor: query.cursor, limit: query.limit ?? 20 }),
    where: {
      title: query.search ? { contains: query.search, mode: "insensitive" } : undefined,
      status: query.status,
      companyId: query.companyId,
      categoryId: query.categoryId,
      urgency: query.urgency,
      startDate:
        query.startDateFrom || query.startDateTo
          ? {
              gte: query.startDateFrom ? new Date(query.startDateFrom) : undefined,
              lte: query.startDateTo ? new Date(query.startDateTo) : undefined,
            }
          : undefined,
    },
    orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
    include: { company: true, category: true },
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit ?? 20);

  return { items: items.map(toListItem), nextCursor };
}

export async function getJobOrderDetail(id: string): Promise<JobOrderDetail> {
  const jobOrder = await scopedDb.jobOrder.findUnique({ where: { id }, include: { company: true, category: true } });
  if (!jobOrder) throw AppError.notFound("Job Order not found");

  const createdBy = jobOrder.createdById
    ? await scopedDb.user.findUnique({ where: { id: jobOrder.createdById } })
    : null;

  return {
    ...toListItem(jobOrder),
    description: jobOrder.description,
    location: readLocationJson(jobOrder.location),
    scheduleNotes: jobOrder.scheduleNotes,
    requirements: (jobOrder.requirements as string[] | null) ?? [],
    createdById: jobOrder.createdById,
    createdByName: createdBy ? `${createdBy.firstName} ${createdBy.lastName}` : null,
    updatedAt: jobOrder.updatedAt.toISOString(),
  };
}

export async function createJobOrder(input: CreateJobOrderInput) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  // F5.1: Company/Category deben resolver vía scopedDb — si pertenecen a
  // otro tenant, la extensión de tenancy ya los devuelve como null acá,
  // sin necesidad de un chequeo de tenancy manual adicional.
  const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw AppError.badRequest("Company not found");

  const category = await scopedDb.jobCategory.findUnique({ where: { id: input.categoryId } });
  if (!category) throw AppError.badRequest("Job category not found");

  await assertValidRequirementKeys(input.requirements);

  const jobOrder = await scopedDb.jobOrder.create({
    data: {
      // F5.1: la extensión de tenancy inyecta tenantId igual en runtime
      // (STRICT_TENANT_MODELS) — el tipo generado por Prisma no lo
      // refleja, así que hay que pasarlo a mano para que compile (mismo
      // patrón ya documentado en agentMemory.create, ver F3).
      tenantId: ctx.tenantId,
      companyId: input.companyId,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description,
      workersNeeded: input.workersNeeded,
      billRate: input.billRate,
      payRate: input.payRate,
      location: toLocationJson(input.location) as never,
      shiftType: input.shiftType ?? "DAY",
      scheduleNotes: input.scheduleNotes,
      startDate: new Date(input.startDate),
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      // F5.1: SIEMPRE DRAFT al crear — el input no tiene ni siquiera un
      // campo `status` que pudiera sobrescribir esto.
      status: "DRAFT",
      urgency: input.urgency ?? "MEDIUM",
      requirements: input.requirements ?? [],
      // F5.1: del contexto de tenancy (usuario autenticado/dev-bypass
      // validado), nunca del body — createJobOrderInputSchema ni
      // siquiera declara este campo.
      createdById: ctx.userId,
    },
    include: { company: true, category: true },
  });

  await logActivity({
    entityType: "jobOrder",
    entityId: jobOrder.id,
    type: "SYSTEM",
    subject: `Job Order created (DRAFT): ${jobOrder.title}`,
  });
  await logAuditEvent({
    action: "jobOrder.created",
    entityType: "jobOrder",
    entityId: jobOrder.id,
    after: { title: jobOrder.title, companyId: jobOrder.companyId, status: jobOrder.status },
  });

  return toListItem(jobOrder);
}

export async function updateJobOrder(id: string, input: UpdateJobOrderInput) {
  // Verify-then-act: scopedDb.jobOrder.findUnique ya está tenant-scoped
  // (STRICT_TENANT_MODELS) — si el registro es de otro tenant, esto
  // devuelve null antes de tocar nada.
  const existing = await scopedDb.jobOrder.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound("Job Order not found");

  if (input.companyId) {
    const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
    if (!company) throw AppError.badRequest("Company not found");
  }
  if (input.categoryId) {
    const category = await scopedDb.jobCategory.findUnique({ where: { id: input.categoryId } });
    if (!category) throw AppError.badRequest("Job category not found");
  }
  await assertValidRequirementKeys(input.requirements);

  // F5.1: los cruces de campos (billRate > payRate, endDate >= startDate)
  // se validan acá contra los valores YA EXISTENTES fusionados con el
  // patch — un PATCH parcial que solo trae uno de los dos lados de cada
  // comparación igual queda protegido, algo que el schema de Zod (que
  // solo ve el body aislado) no puede garantizar por sí solo.
  const mergedBillRate = input.billRate ?? Number(existing.billRate);
  const mergedPayRate = input.payRate ?? Number(existing.payRate);
  if (mergedBillRate <= mergedPayRate) {
    throw AppError.badRequest("billRate must be greater than payRate");
  }
  const mergedStartDate = input.startDate ? new Date(input.startDate) : existing.startDate;
  const mergedEndDate = input.endDate !== undefined ? (input.endDate ? new Date(input.endDate) : null) : existing.endDate;
  if (mergedEndDate && mergedEndDate < mergedStartDate) {
    throw AppError.badRequest("endDate cannot be before startDate");
  }

  const updated = await scopedDb.jobOrder.update({
    where: { id },
    data: {
      companyId: input.companyId,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description,
      workersNeeded: input.workersNeeded,
      billRate: input.billRate,
      payRate: input.payRate,
      location: input.location ? (toLocationJson(input.location) as never) : undefined,
      shiftType: input.shiftType,
      scheduleNotes: input.scheduleNotes,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate !== undefined ? (input.endDate ? new Date(input.endDate) : null) : undefined,
      urgency: input.urgency,
      requirements: input.requirements as never,
      // F5.1: status/workersFilled/createdById/tenantId nunca aparecen
      // acá — updateJobOrderInputSchema no los declara, así que ni
      // siquiera pueden llegar en `input`.
    },
    include: { company: true, category: true },
  });

  await logActivity({
    entityType: "jobOrder",
    entityId: id,
    type: "SYSTEM",
    subject: "Job Order updated",
  });
  await logAuditEvent({
    action: "jobOrder.updated",
    entityType: "jobOrder",
    entityId: id,
    before: { title: existing.title, billRate: existing.billRate.toString(), payRate: existing.payRate.toString() },
    after: { title: updated.title, billRate: updated.billRate.toString(), payRate: updated.payRate.toString() },
  });

  return toListItem(updated);
}

export async function updateJobOrderStatus(id: string, input: UpdateJobOrderStatusInput) {
  const existing = await scopedDb.jobOrder.findUnique({ where: { id }, include: { company: true, category: true } });
  if (!existing) throw AppError.notFound("Job Order not found");

  const from = existing.status as never;
  const to = input.status;

  // F5.1: idempotente — pedir el estado ya vigente es un no-op exitoso,
  // nunca un error ni una segunda entrada de Activity/AuditLog.
  if (from === to) {
    return toListItem(existing);
  }

  if (!isValidJobOrderStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Job Order from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: JOB_ORDER_STATUS_TRANSITIONS[from],
    });
  }

  const updated = await scopedDb.jobOrder.update({
    where: { id },
    data: { status: to },
    include: { company: true, category: true },
  });

  await logActivity({
    entityType: "jobOrder",
    entityId: id,
    type: "SYSTEM",
    subject: `Status changed: ${existing.status} → ${to}`,
  });
  await logAuditEvent({
    action: "jobOrder.status_changed",
    entityType: "jobOrder",
    entityId: id,
    before: { status: existing.status },
    after: { status: to },
  });

  return toListItem(updated);
}

/**
 * F8.1: Job Intake Intelligence -- wiring impuro entre
 * `recruiting-intelligence/job-intake.ts` (puro) y el catálogo real de
 * JobCategory/DocumentType del tenant. Nunca crea un JobOrder -- solo
 * interpreta la instrucción y devuelve el preview estructurado para que
 * el humano revise/complete antes de llamar a `createJobOrder` (mismo
 * patrón "plan-only, nunca ejecuta" ya establecido por
 * `planMissionOnly` en F7.2).
 */
export async function interpretJobOrderIntake(rawInstruction: string): Promise<JobIntakeResult> {
  const [categories, documentTypes] = await Promise.all([
    scopedDb.jobCategory.findMany({ include: { industry: true } }),
    scopedDb.documentType.findMany(),
  ]);

  return interpretJobIntake({
    rawInstruction,
    knownJobCategories: categories.map((c) => ({ id: c.id, name: c.name, industryName: c.industry?.name ?? null })),
    knownDocumentTypes: documentTypes.map((d) => ({ key: d.key, name: d.name, category: d.category })),
  });
}
