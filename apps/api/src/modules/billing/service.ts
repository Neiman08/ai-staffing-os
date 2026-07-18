import type {
  BillingReadinessQuery,
  BillingReadinessResultDto,
  CreateInvoiceInput,
  CreatePaymentInput,
  InvoiceDetail,
  InvoiceListItem,
  InvoiceQuery,
  Paginated,
} from "@ai-staffing-os/shared";
import { INVOICE_STATUS_TRANSITIONS, isValidInvoiceStatusTransition } from "@ai-staffing-os/shared";
import { prisma } from "@ai-staffing-os/db";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext, runWithTenancyContext } from "../../core/tenancy/context";
import { buildCursorArgs, toCursorPage } from "../../core/pagination";
import { logActivity } from "../../core/activity-log";
import { logAuditEvent } from "../../core/audit-log";
import { AppError } from "../../core/errors";
import { evaluateBillingReadiness } from "../operations-intelligence/billing-readiness";

// F5.8 (plan §10.2, aprobado como valor provisional — mismo criterio que
// OT_MULTIPLIER en F5.7 §9.2): sin un campo de términos de pago por
// Company todavía, se usa net-30 desde la fecha de creación del invoice.
const DEFAULT_PAYMENT_TERM_DAYS = 30;

// F5.8 (plan §10.2): solo se factura trabajo de un PayrollRun ya
// APPROVED o más adelante en su ciclo — DRAFT/PENDING_APPROVAL todavía
// pueden no reflejar costos reales aprobados internamente.
const BILLABLE_PAYROLL_RUN_STATUSES = ["APPROVED", "PAID", "EXPORTED"] as const;

const INVOICE_INCLUDE = {
  company: { select: { name: true } },
  payments: true,
} as const;

type InvoiceRow = {
  id: string;
  number: string;
  companyId: string;
  company: { name: string };
  periodStart: Date;
  periodEnd: Date;
  subtotal: { toString(): string };
  total: { toString(): string };
  status: string;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  payments: Array<{
    id: string;
    amount: { toString(): string };
    paidAt: Date;
    method: string | null;
    reference: string | null;
    createdAt: Date;
  }>;
};

function paidTotalOf(row: InvoiceRow): number {
  return row.payments.reduce((sum, p) => sum + Number(p.amount), 0);
}

function toListItem(row: InvoiceRow): InvoiceListItem {
  const paidTotal = paidTotalOf(row);
  const total = Number(row.total);
  return {
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    companyName: row.company.name,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    subtotal: row.subtotal.toString(),
    total: row.total.toString(),
    paidTotal: paidTotal.toFixed(2),
    balance: (total - paidTotal).toFixed(2),
    status: row.status as never,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listInvoices(query: InvoiceQuery): Promise<Paginated<InvoiceListItem>> {
  const sortField = query.sortBy ?? "createdAt";
  const sortDir = query.sortDir ?? "desc";

  const rows = await scopedDb.invoice.findMany({
    ...buildCursorArgs(query),
    where: {
      companyId: query.companyId,
      status: query.status,
      number: query.search ? { contains: query.search, mode: "insensitive" } : undefined,
    },
    orderBy: [{ [sortField]: sortDir }, { id: "desc" }],
    include: INVOICE_INCLUDE,
  });

  const { items, nextCursor } = toCursorPage(rows, query.limit);
  return { items: items.map(toListItem), nextCursor };
}

export async function getInvoiceDetail(id: string): Promise<InvoiceDetail> {
  const row = await scopedDb.invoice.findUnique({
    where: { id },
    include: { ...INVOICE_INCLUDE, lines: true },
  });
  if (!row) throw AppError.notFound("Invoice not found");

  return {
    ...toListItem(row),
    lines: row.lines.map((line: { id: string; description: string; quantity: { toString(): string }; rate: { toString(): string }; amount: { toString(): string } }) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity.toString(),
      rate: line.rate.toString(),
      amount: line.amount.toString(),
    })),
    payments: row.payments
      .slice()
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
      .map((p) => ({
        id: p.id,
        amount: p.amount.toString(),
        paidAt: p.paidAt.toISOString(),
        method: p.method,
        reference: p.reference,
        createdAt: p.createdAt.toISOString(),
      })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function nextInvoiceNumber(year: number): Promise<string> {
  const count = await scopedDb.invoice.count();
  return `INV-${year}-${String(count + 1).padStart(5, "0")}`;
}

// ================= Billing Readiness (F9.8) =================

/**
 * F9.8: recalculado en cada llamada -- nunca persistido (mismo criterio
 * que PayrollReadiness, F9.7). Sin emisión real de factura, sin envío a
 * cliente -- solo agrega señales que ya existen (PayrollItem/PayrollRun.
 * status/Contract.status) y determina si (Company, período) puede
 * facturarse con confianza razonable. El Contract elegido, si hay más de
 * uno, prefiere uno ACTIVE; si ninguno lo está, el más reciente por
 * createdAt -- una Company sin Contract en archivo nunca bloquea (solo
 * genera un reviewNote informativo, ver `evaluateBillingReadiness`).
 */
export async function getBillingReadiness(query: BillingReadinessQuery): Promise<BillingReadinessResultDto> {
  const company = await scopedDb.company.findUnique({ where: { id: query.companyId } });
  if (!company) throw AppError.notFound("Company not found");

  const periodStart = new Date(query.periodStart);
  const periodEnd = new Date(query.periodEnd);

  const contracts = await scopedDb.contract.findMany({ where: { companyId: query.companyId }, orderBy: { createdAt: "desc" } });
  const contract = contracts.find((c) => c.status === "ACTIVE") ?? contracts[0] ?? null;

  const items = await scopedDb.payrollItem.findMany({
    where: {
      payrollRun: { periodStart: { gte: periodStart }, periodEnd: { lte: periodEnd } },
      assignment: { jobOrder: { companyId: query.companyId } },
    },
    include: { payrollRun: { select: { status: true } } },
  });

  const result = evaluateBillingReadiness({
    contractStatus: contract?.status ?? null,
    payrollItems: items.map((i) => ({
      billAmount: Number(i.billAmount),
      grossPay: Number(i.grossPay),
      invoiced: i.invoiced,
      payrollRunBillable: (BILLABLE_PAYROLL_RUN_STATUSES as readonly string[]).includes(i.payrollRun.status),
    })),
  });

  return {
    companyId: query.companyId,
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    payrollItemCount: items.length,
    ...result,
  };
}

/**
 * F5.8 (plan §10.2, aprobado): agrega PayrollItem.billAmount no facturado
 * todavía (invoiced = false) para companyId, agrupado por Assignment —
 * una InvoiceLine por worker/assignment, con el desglose de horas. Solo
 * PayrollItems de un PayrollRun ya BILLABLE (ver constante arriba) y cuyo
 * período está contenido dentro del rango pedido. Marca los PayrollItems
 * incluidos como invoiced = true en la misma transacción — evita que una
 * segunda generación para el mismo período los vuelva a facturar.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceListItem> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw AppError.badRequest("Company not found");

  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);

  const eligibleItems = await scopedDb.payrollItem.findMany({
    where: {
      invoiced: false,
      payrollRun: {
        status: { in: [...BILLABLE_PAYROLL_RUN_STATUSES] },
        periodStart: { gte: periodStart },
        periodEnd: { lte: periodEnd },
      },
      assignment: { jobOrder: { companyId: input.companyId } },
    },
    include: { worker: { include: { candidate: true } }, assignment: { include: { jobOrder: true } } },
  });

  if (eligibleItems.length === 0) {
    throw AppError.badRequest("No unbilled approved payroll items were found for this company and period", {
      companyId: input.companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
  }

  const linesData = eligibleItems.map((item) => {
    const quantity = Number(item.regularHours) + Number(item.otHours);
    const amount = Number(item.billAmount);
    const rate = quantity > 0 ? amount / quantity : 0;
    return {
      description: `${item.worker.candidate.firstName} ${item.worker.candidate.lastName} — ${item.assignment.jobOrder.title}`,
      quantity,
      rate,
      amount,
      payrollItemId: item.id,
    };
  });

  const subtotal = linesData.reduce((sum, l) => sum + l.amount, 0);
  const number = await nextInvoiceNumber(periodStart.getFullYear());
  const dueDate = new Date(Date.now() + DEFAULT_PAYMENT_TERM_DAYS * 24 * 60 * 60 * 1000);

  const invoice = await scopedDb.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        tenantId: ctx.tenantId,
        companyId: input.companyId,
        number,
        periodStart,
        periodEnd,
        subtotal,
        total: subtotal,
        status: "DRAFT",
        dueDate,
        lines: {
          create: linesData.map(({ payrollItemId: _payrollItemId, ...line }) => line),
        },
      },
      include: INVOICE_INCLUDE,
    });

    await tx.payrollItem.updateMany({
      where: { id: { in: linesData.map((l) => l.payrollItemId) } },
      data: { invoiced: true },
    });

    return created;
  });

  await logActivity({
    entityType: "invoice",
    entityId: invoice.id,
    type: "SYSTEM",
    subject: `Invoice ${number} generated: ${input.periodStart.slice(0, 10)} → ${input.periodEnd.slice(0, 10)} (${linesData.length} lines)`,
  });
  await logAuditEvent({
    action: "invoice.created",
    entityType: "invoice",
    entityId: invoice.id,
    after: { number, companyId: input.companyId, subtotal, lineCount: linesData.length },
  });

  return toListItem(invoice);
}

export async function updateInvoiceStatus(id: string, to: InvoiceListItem["status"]): Promise<InvoiceDetail> {
  const existing = await scopedDb.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  if (!existing) throw AppError.notFound("Invoice not found");

  const from = existing.status as never;
  if (from === to) return getInvoiceDetail(id);

  // F5.8 (plan §10.3, aprobado): PAID y OVERDUE son siempre derivados
  // (balance saldado vía Payment / dueDate vencida vía sweep) — nunca
  // alcanzables por esta transición manual, sin importar si la matriz
  // los listaría como técnicamente válidos desde el estado actual.
  if (to === "PAID") {
    throw AppError.badRequest("Invoice PAID status is derived from payments — register a payment instead");
  }
  if (to === "OVERDUE") {
    throw AppError.badRequest("Invoice OVERDUE status is derived automatically from the due date");
  }

  if (!isValidInvoiceStatusTransition(from, to)) {
    throw AppError.badRequest(`Cannot transition Invoice from ${existing.status} to ${to}`, {
      from: existing.status,
      to,
      allowedFromCurrentStatus: INVOICE_STATUS_TRANSITIONS[from],
    });
  }

  await scopedDb.invoice.update({ where: { id }, data: { status: to } });

  await logActivity({
    entityType: "invoice",
    entityId: id,
    type: "SYSTEM",
    subject: `Invoice status changed: ${existing.status} → ${to}`,
  });
  await logAuditEvent({
    action: "invoice.status_changed",
    entityType: "invoice",
    entityId: id,
    before: { status: existing.status },
    after: { status: to },
  });

  return getInvoiceDetail(id);
}

/**
 * F5.8 (plan §10.1/§10.3, Opción B aprobada): registra un pago real,
 * nunca sobreescribe uno anterior. Si el pago salda el balance completo,
 * la Invoice pasa automáticamente a PAID en la misma operación — el
 * mismo criterio de "estado derivado de datos reales" ya aplicado a
 * JobOrder.status/Worker.status/Worker.complianceStatus en F5.4/F5.5.
 */
export async function createPayment(invoiceId: string, input: CreatePaymentInput): Promise<InvoiceDetail> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const existing = await scopedDb.invoice.findUnique({ where: { id: invoiceId }, include: INVOICE_INCLUDE });
  if (!existing) throw AppError.notFound("Invoice not found");

  if (existing.status === "DRAFT") {
    throw AppError.badRequest("Cannot register a payment before the invoice is sent");
  }
  if (existing.status === "VOID") {
    throw AppError.badRequest("Cannot register a payment on a VOID invoice");
  }
  if (existing.status === "PAID") {
    throw AppError.badRequest("This invoice is already fully paid");
  }

  const currentBalance = Number(existing.total) - paidTotalOf(existing);
  if (input.amount > currentBalance) {
    throw AppError.badRequest("Payment exceeds the outstanding balance", {
      amount: input.amount,
      balance: currentBalance.toFixed(2),
    });
  }

  const payment = await scopedDb.payment.create({
    data: {
      tenantId: ctx.tenantId,
      invoiceId,
      amount: input.amount,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
      method: input.method,
      reference: input.reference,
    },
  });

  const newBalance = currentBalance - input.amount;
  if (newBalance <= 0) {
    await scopedDb.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
  }

  await logActivity({
    entityType: "invoice",
    entityId: invoiceId,
    type: "SYSTEM",
    subject: `Payment registered: $${input.amount.toFixed(2)}${newBalance <= 0 ? " (invoice fully paid)" : ""}`,
  });
  await logAuditEvent({
    action: "payment.created",
    entityType: "invoice",
    entityId: invoiceId,
    after: { paymentId: payment.id, amount: input.amount, newBalance: newBalance.toFixed(2) },
  });

  return getInvoiceDetail(invoiceId);
}

/**
 * F5.8 (plan §10.3): sweep periódico — mismo patrón que
 * runComplianceAlertSweepForTenant (F5.5), incluyendo cómo se establece
 * un TenancyContext manual (no hay request HTTP acá): se toma prestada
 * la identidad del primer CEO/Admin activo del tenant únicamente para
 * satisfacer el requisito de scopedDb, igual que el sweep de compliance.
 * SENT con dueDate vencida y balance > 0 pasa a OVERDUE; nunca toca
 * DRAFT/PAID/VOID.
 */
export async function flagOverdueInvoicesForTenant(tenantId: string): Promise<{ flagged: number }> {
  const operator = await prisma.user.findFirst({
    where: { tenantId, isActive: true, role: { name: { in: ["CEO", "Admin"] } } },
    orderBy: { createdAt: "asc" },
  });
  if (!operator) return { flagged: 0 };

  return runWithTenancyContext({ tenantId, userId: operator.id, permissions: [] }, async () => {
    const now = new Date();
    const candidates = await scopedDb.invoice.findMany({
      where: { status: "SENT", dueDate: { lt: now } },
      include: { payments: true },
    });

    const overdueIds = candidates
      .filter((inv) => Number(inv.total) - inv.payments.reduce((s, p) => s + Number(p.amount), 0) > 0)
      .map((inv) => inv.id);

    if (overdueIds.length > 0) {
      await scopedDb.invoice.updateMany({ where: { id: { in: overdueIds } }, data: { status: "OVERDUE" } });
    }

    return { flagged: overdueIds.length };
  });
}
