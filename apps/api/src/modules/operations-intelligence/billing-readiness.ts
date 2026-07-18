/**
 * F9.8: Billing Readiness -- puro, determinista, sin Prisma/fetch/LLM.
 * Evalúa si un (Company, período) está listo para generar un Invoice
 * real (F5.8) -- NUNCA emite una factura real, NUNCA la envía a un
 * cliente. Es una vista de solo lectura sobre datos que ya existen
 * (PayrollItem/PayrollRun/Contract), nunca un modelo persistido nuevo
 * (mismo criterio que PayrollReadiness, F9.7) -- se recalcula en cada
 * consulta.
 */

export const BILLING_READINESS_VERSION = 1;

export type BillingReadinessStatus = "NOT_READY" | "NEEDS_REVIEW" | "READY_FOR_INVOICE" | "EXPORTED" | "BLOCKED";

export interface BillingReadinessPayrollItemInput {
  billAmount: number;
  grossPay: number;
  invoiced: boolean;
  /** true si su PayrollRun ya está en un estado facturable (ver billing/service.ts BILLABLE_PAYROLL_RUN_STATUSES: APPROVED/PAID/EXPORTED). */
  payrollRunBillable: boolean;
}

export interface BillingReadinessInput {
  /** null = sin Contract en archivo para esta Company -- nunca se asume uno. */
  contractStatus: string | null;
  /** TODOS los PayrollItem de esta Company+período, sin filtrar -- el evaluador decide qué subconjunto es elegible. */
  payrollItems: BillingReadinessPayrollItemInput[];
}

export interface BillingReadinessResult {
  status: BillingReadinessStatus;
  blockers: string[];
  reviewNotes: string[];
  /** Decimal-safe: strings con 2 decimales, nunca floats sin formatear. */
  estimatedRevenue: string;
  estimatedLaborCost: string;
  estimatedGrossProfit: string;
  estimatedMarginPercent: string;
}

function computeMoney(eligible: BillingReadinessPayrollItemInput[]): Pick<
  BillingReadinessResult,
  "estimatedRevenue" | "estimatedLaborCost" | "estimatedGrossProfit" | "estimatedMarginPercent"
> {
  const estimatedRevenue = eligible.reduce((sum, i) => sum + i.billAmount, 0);
  const estimatedLaborCost = eligible.reduce((sum, i) => sum + i.grossPay, 0);
  const estimatedGrossProfit = estimatedRevenue - estimatedLaborCost;
  const estimatedMarginPercent = estimatedRevenue > 0 ? (estimatedGrossProfit / estimatedRevenue) * 100 : 0;
  return {
    estimatedRevenue: estimatedRevenue.toFixed(2),
    estimatedLaborCost: estimatedLaborCost.toFixed(2),
    estimatedGrossProfit: estimatedGrossProfit.toFixed(2),
    estimatedMarginPercent: estimatedMarginPercent.toFixed(2),
  };
}

/**
 * Prioridad determinística: `BLOCKED` (Contract EXPIRED/TERMINATED en
 * archivo -- un Contract ausente NUNCA bloquea, solo genera un
 * `reviewNote`, ver más abajo) > si hay items elegibles ahora mismo:
 * `NEEDS_REVIEW` cuando además existen otros items del mismo período
 * todavía no facturables (facturación parcial, requiere juicio humano)
 * o `READY_FOR_INVOICE` si no > si NO hay items elegibles ahora mismo:
 * `NOT_READY` cuando hay items pendientes de aprobación de nómina, o
 * `EXPORTED` cuando el período ya se facturó por completo, o `NOT_READY`
 * cuando nunca hubo nada que facturar.
 */
export function evaluateBillingReadiness(input: BillingReadinessInput): BillingReadinessResult {
  const eligible = input.payrollItems.filter((i) => !i.invoiced && i.payrollRunBillable);
  const alreadyInvoiced = input.payrollItems.filter((i) => i.invoiced);
  const pendingApproval = input.payrollItems.filter((i) => !i.invoiced && !i.payrollRunBillable);
  const money = computeMoney(eligible);

  const blockers: string[] = [];
  if (input.contractStatus === "EXPIRED") blockers.push("Contract on file is EXPIRED");
  if (input.contractStatus === "TERMINATED") blockers.push("Contract on file is TERMINATED");
  if (blockers.length > 0) {
    return { status: "BLOCKED", blockers, reviewNotes: [], ...money };
  }

  const reviewNotes: string[] = [];
  if (input.contractStatus === null) reviewNotes.push("No contract on file for this company");

  if (eligible.length > 0) {
    if (pendingApproval.length > 0) {
      return {
        status: "NEEDS_REVIEW",
        blockers: [`${pendingApproval.length} payroll item(s) for this period are still pending internal approval, not yet billable -- consider whether to invoice partially now`],
        reviewNotes,
        ...money,
      };
    }
    return { status: "READY_FOR_INVOICE", blockers: [], reviewNotes, ...money };
  }

  if (pendingApproval.length > 0) {
    return { status: "NOT_READY", blockers: [`${pendingApproval.length} payroll item(s) are still pending internal approval`], reviewNotes, ...money };
  }
  if (alreadyInvoiced.length > 0) {
    return { status: "EXPORTED", blockers: [], reviewNotes, ...money };
  }
  return { status: "NOT_READY", blockers: ["No billable payroll items found for this company and period"], reviewNotes, ...money };
}
