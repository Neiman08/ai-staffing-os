import { z } from "zod";
import { paginationQuerySchema } from "./common";

// F5.8: enum real (packages/db/prisma/schema.prisma InvoiceStatus) — no se
// amplía. PAID es siempre derivado (balance llega a 0 vía Payment, nunca se
// setea a mano — ver isValidInvoiceStatusTransition más abajo). OVERDUE se
// deriva de dueDate vencida (sweep periódico, mismo patrón que
// runComplianceAlertSweepForTenant de F5.5), tampoco manual.
export const invoiceStatusSchema = z.enum(["DRAFT", "SENT", "PAID", "OVERDUE", "VOID"]);
export type InvoiceStatusValue = z.infer<typeof invoiceStatusSchema>;

/**
 * F5.8 (plan §10.4): transiciones manuales vía PATCH .../status son
 * DRAFT->SENT (permiso especial invoices.send) y ->VOID desde cualquier
 * estado no terminal. PAID nunca es alcanzable desde el endpoint manual —
 * se deriva exclusivamente al registrar un Payment que salda el balance
 * (ver recomputeInvoiceStatus en el servicio). Se mantiene en esta matriz
 * para que isValidInvoiceStatusTransition represente el modelo completo,
 * pero el servicio rechaza explícitamente un intento manual de ->PAID.
 */
export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatusValue, InvoiceStatusValue[]> = {
  DRAFT: ["SENT", "VOID"],
  SENT: ["PAID", "OVERDUE", "VOID"],
  OVERDUE: ["PAID", "VOID"],
  PAID: [],
  VOID: [],
};

/** Idempotente: pedir el mismo estado ya vigente siempre es válido (no-op), nunca un error. */
export function isValidInvoiceStatusTransition(from: InvoiceStatusValue, to: InvoiceStatusValue): boolean {
  if (from === to) return true;
  return INVOICE_STATUS_TRANSITIONS[from].includes(to);
}

// F5.8 (plan §10.2): genera un Invoice agregando PayrollItem.billAmount no
// facturado todavía (invoiced = false) de PayrollRuns en estado APPROVED o
// posterior, para la companyId dada, agrupado por Assignment (una línea
// por worker/assignment). No agrega tax/currency — no se pidieron
// (mismo criterio D7: sin cálculos fiscales).
export const createInvoiceInputSchema = z
  .object({
    companyId: z.string().min(1),
    periodStart: z.string().min(1),
    periodEnd: z.string().min(1),
  })
  .refine((v) => new Date(v.periodEnd) >= new Date(v.periodStart), {
    message: "periodEnd cannot be before periodStart",
    path: ["periodEnd"],
  });
export type CreateInvoiceInput = z.infer<typeof createInvoiceInputSchema>;

export const updateInvoiceStatusInputSchema = z.object({
  status: invoiceStatusSchema,
});
export type UpdateInvoiceStatusInput = z.infer<typeof updateInvoiceStatusInputSchema>;

// F5.8 (plan §10.1, Opción B aprobada): un pago parcial real, nunca
// sobreescribe otro. amount se valida contra el balance restante en el
// servicio (no acá, requiere leer el Invoice actual).
export const createPaymentInputSchema = z.object({
  amount: z.number().positive(),
  paidAt: z.string().optional(),
  method: z.string().optional(),
  reference: z.string().optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

export const paymentSchema = z.object({
  id: z.string(),
  amount: z.string(),
  paidAt: z.string(),
  method: z.string().nullable(),
  reference: z.string().nullable(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const invoiceLineSchema = z.object({
  id: z.string(),
  description: z.string(),
  quantity: z.string(),
  rate: z.string(),
  amount: z.string(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceListItemSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  subtotal: z.string(),
  total: z.string(),
  paidTotal: z.string(),
  balance: z.string(),
  status: invoiceStatusSchema,
  dueDate: z.string().nullable(),
  createdAt: z.string(),
});
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>;

export const invoiceQuerySchema = paginationQuerySchema.extend({
  companyId: z.string().optional(),
  status: invoiceStatusSchema.optional(),
  search: z.string().optional(), // contains sobre Invoice.number
  sortBy: z.enum(["createdAt", "dueDate", "total"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>;

export const invoiceDetailSchema = invoiceListItemSchema.extend({
  lines: z.array(invoiceLineSchema),
  payments: z.array(paymentSchema),
  updatedAt: z.string(),
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;

// ================= Billing Readiness (F9.8) =================

// F9.8: recalculado en cada consulta (nunca persistido) -- consume
// PayrollItem/PayrollRun/Contract ya existentes, ver
// apps/api/.../operations-intelligence/billing-readiness.ts.
export const billingReadinessStatusSchema = z.enum(["NOT_READY", "NEEDS_REVIEW", "READY_FOR_INVOICE", "EXPORTED", "BLOCKED"]);
export type BillingReadinessStatusValue = z.infer<typeof billingReadinessStatusSchema>;

export const billingReadinessQuerySchema = z.object({
  companyId: z.string().min(1),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
});
export type BillingReadinessQuery = z.infer<typeof billingReadinessQuerySchema>;

export const billingReadinessResultSchema = z.object({
  companyId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: billingReadinessStatusSchema,
  blockers: z.array(z.string()),
  reviewNotes: z.array(z.string()),
  estimatedRevenue: z.string(),
  estimatedLaborCost: z.string(),
  estimatedGrossProfit: z.string(),
  estimatedMarginPercent: z.string(),
  payrollItemCount: z.number(),
});
export type BillingReadinessResultDto = z.infer<typeof billingReadinessResultSchema>;
