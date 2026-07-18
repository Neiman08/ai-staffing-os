/**
 * F11.6: margen día por día, antigüedad de facturas impagas y costo de
 * payroll sobre un rango configurable -- extiende la serie de 14 días
 * hardcodeada de dashboard/service.ts (misma fórmula real: horas *
 * (billRate - payRate) snapshot de la Assignment) y reutiliza el mismo
 * cálculo de balance (total - sum(Payment.amount)) que
 * billing/scheduler.ts:flagOverdueInvoicesForTenant (F5.8) ya usa para
 * decidir qué facturas están vencidas.
 */
import type { AnalyticsPeriodQuery, FinancialMetrics } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { comparePeriods, daysBetween, previousPeriod, resolvePeriod, toResolvedPeriod, type DateRange } from "../../core/analytics/period";
import { toCsvDocument } from "../../core/analytics/csv";

const DEFAULT_WINDOW_DAYS = 30;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * F11.7: totales de horas/margen para un rango -- usado para comparar el
 * período anterior contra el actual (cuyos totales ya salen de sumar
 * financial.marginTrend, sin volver a consultar TimeEntry dos veces
 * para el mismo rango).
 */
async function sumHoursAndMargin(range: DateRange): Promise<{ hours: number; margin: number }> {
  const timeEntries = await scopedDb.timeEntry.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    include: { assignment: true },
  });
  let hours = 0;
  let margin = 0;
  for (const entry of timeEntries) {
    const totalHours = Number(entry.regularHours) + Number(entry.overtimeHours) + Number(entry.doubleHours);
    hours += totalHours;
    margin += totalHours * (Number(entry.assignment.billRate) - Number(entry.assignment.payRate));
  }
  return { hours, margin };
}

export async function getFinancialMetrics(query: AnalyticsPeriodQuery): Promise<FinancialMetrics> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const has = (permission: string) => ctx.permissions.includes(permission);
  // Mismo criterio que dashboard/service.ts (F6.8): payrollRuns.view o
  // invoices.view ya son, juntos, el único par de permisos que hoy
  // exponen billRate/payRate/margen agregado en algún otro módulo.
  const canViewFinancials = has("payrollRuns.view") || has("invoices.view");
  const canViewInvoices = has("invoices.view");
  const canViewPayroll = has("payrollRuns.view");

  if (!canViewFinancials) {
    return { generatedAt: new Date().toISOString(), financial: {} };
  }

  const range = resolvePeriod(query, DEFAULT_WINDOW_DAYS);
  const period = toResolvedPeriod(range);
  const financial: FinancialMetrics["financial"] = { period };

  const timeEntries = await scopedDb.timeEntry.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    include: { assignment: true },
  });

  // Serie dispersa (solo días con datos reales), no un relleno de ceros
  // para cada día del rango -- un rango de meses/años no debe generar
  // miles de puntos vacíos, y un día sin TimeEntry real no es lo mismo
  // que "hubo cero horas ese día" (podría ser un día sin operación).
  const buckets = new Map<string, { hours: number; margin: number }>();
  for (const entry of timeEntries) {
    const totalHours = Number(entry.regularHours) + Number(entry.overtimeHours) + Number(entry.doubleHours);
    const billRate = Number(entry.assignment.billRate);
    const payRate = Number(entry.assignment.payRate);
    const margin = totalHours * (billRate - payRate);
    const key = dateKey(entry.date);
    const bucket = buckets.get(key) ?? { hours: 0, margin: 0 };
    bucket.hours += totalHours;
    bucket.margin += margin;
    buckets.set(key, bucket);
  }
  financial.marginTrend = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, hours: Number(v.hours.toFixed(2)), margin: Number(v.margin.toFixed(2)) }));

  // F11.7: comparación real de horas/margen contra el período anterior
  // equivalente -- los totales actuales salen de sumar los buckets ya
  // calculados arriba, solo el período anterior requiere una consulta
  // nueva. invoiceAging queda deliberadamente sin comparación (ver
  // financialComparisonSchema en packages/shared).
  const currentTotals = financial.marginTrend.reduce(
    (acc, p) => ({ hours: acc.hours + p.hours, margin: acc.margin + p.margin }),
    { hours: 0, margin: 0 },
  );
  const previousRange = previousPeriod(range);
  financial.previousPeriod = toResolvedPeriod(previousRange);
  const previousTotals = await sumHoursAndMargin(previousRange);
  financial.comparison = {
    totalHours: comparePeriods(Number(currentTotals.hours.toFixed(2)), Number(previousTotals.hours.toFixed(2))),
    totalMargin: comparePeriods(Number(currentTotals.margin.toFixed(2)), Number(previousTotals.margin.toFixed(2))),
  };

  if (canViewInvoices) {
    const unpaidInvoices = await scopedDb.invoice.findMany({
      where: { status: { in: ["SENT", "OVERDUE"] } },
      include: { payments: true },
    });
    const now = new Date();
    let current = 0;
    let days31to60 = 0;
    let days61to90 = 0;
    let over90 = 0;
    let totalOutstanding = 0;

    for (const invoice of unpaidInvoices) {
      const balance = Number(invoice.total) - invoice.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      if (balance <= 0) continue;
      totalOutstanding += balance;
      // Sin dueDate real no se inventa una antigüedad -- la factura
      // cuenta en totalOutstanding pero no en ningún bucket de días.
      if (!invoice.dueDate) continue;
      const daysOverdue = daysBetween(invoice.dueDate, now);
      if (daysOverdue <= 30) current += balance;
      else if (daysOverdue <= 60) days31to60 += balance;
      else if (daysOverdue <= 90) days61to90 += balance;
      else over90 += balance;
    }

    financial.invoiceAging = {
      current: current.toFixed(2),
      days31to60: days31to60.toFixed(2),
      days61to90: days61to90.toFixed(2),
      over90: over90.toFixed(2),
      totalOutstanding: totalOutstanding.toFixed(2),
    };
  }

  if (canViewPayroll) {
    // Runs cuyo período se solapa con el rango pedido (no solo los que
    // empiezan dentro) -- un run que arrancó antes del `from` pero
    // termina dentro del rango sigue siendo costo real de ese rango.
    const runs = await scopedDb.payrollRun.findMany({
      where: { periodStart: { lte: range.to }, periodEnd: { gte: range.from } },
      select: { totalGross: true, totalBill: true, totalMargin: true },
    });
    const totals = runs.reduce(
      (acc, r) => ({
        gross: acc.gross + Number(r.totalGross),
        bill: acc.bill + Number(r.totalBill),
        margin: acc.margin + Number(r.totalMargin),
      }),
      { gross: 0, bill: 0, margin: 0 },
    );
    financial.payrollCost = {
      totalGross: totals.gross.toFixed(2),
      totalBill: totals.bill.toFixed(2),
      totalMargin: totals.margin.toFixed(2),
      runsIncluded: runs.length,
    };
  }

  return { generatedAt: new Date().toISOString(), financial };
}

/**
 * F11.8: mismo patrón que los otros dos exports -- CSV formateado sobre
 * el mismo cálculo real de getFinancialMetrics, ninguna query nueva.
 * marginTrend se exporta fila por fila (es la única de las tres métricas
 * que ya es una serie, no un escalar).
 */
export async function exportFinancialMetricsCsv(query: AnalyticsPeriodQuery): Promise<{ csv: string; filename: string }> {
  const metrics = await getFinancialMetrics(query);
  const { period, marginTrend, invoiceAging, payrollCost } = metrics.financial;

  const rows: string[][] = [["Metric", "Value"]];
  if (period) rows.push(["Period From", period.from], ["Period To", period.to]);

  if (invoiceAging) {
    rows.push(
      ["Invoice Aging: Current (0-30d)", invoiceAging.current],
      ["Invoice Aging: 31-60d", invoiceAging.days31to60],
      ["Invoice Aging: 61-90d", invoiceAging.days61to90],
      ["Invoice Aging: 90+d", invoiceAging.over90],
      ["Invoice Aging: Total Outstanding", invoiceAging.totalOutstanding],
    );
  }
  if (payrollCost) {
    rows.push(
      ["Payroll: Total Gross", payrollCost.totalGross],
      ["Payroll: Total Bill", payrollCost.totalBill],
      ["Payroll: Total Margin", payrollCost.totalMargin],
      ["Payroll: Runs Included", String(payrollCost.runsIncluded)],
    );
  }

  if (marginTrend?.length) {
    rows.push([], ["Date", "Hours", "Margin"]);
    for (const point of marginTrend) {
      rows.push([point.date, String(point.hours), String(point.margin)]);
    }
  }

  const from = period?.from.slice(0, 10) ?? "all";
  const to = period?.to.slice(0, 10) ?? "time";
  return { csv: toCsvDocument(rows), filename: `financial-metrics-${from}-to-${to}.csv` };
}
