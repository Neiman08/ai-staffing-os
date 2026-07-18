import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBillingReadiness } from "./billing-readiness";

test("an EXPIRED contract on file blocks readiness even with eligible items", () => {
  const result = evaluateBillingReadiness({
    contractStatus: "EXPIRED",
    payrollItems: [{ billAmount: 1000, grossPay: 700, invoiced: false, payrollRunBillable: true }],
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers[0]?.includes("EXPIRED"));
});

test("a TERMINATED contract on file blocks readiness", () => {
  const result = evaluateBillingReadiness({ contractStatus: "TERMINATED", payrollItems: [] });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers[0]?.includes("TERMINATED"));
});

test("a missing contract never blocks -- only generates an informational reviewNote", () => {
  const result = evaluateBillingReadiness({
    contractStatus: null,
    payrollItems: [{ billAmount: 1000, grossPay: 700, invoiced: false, payrollRunBillable: true }],
  });
  assert.equal(result.status, "READY_FOR_INVOICE");
  assert.deepEqual(result.blockers, []);
  assert.ok(result.reviewNotes[0]?.includes("No contract"));
});

test("no payroll items at all is NOT_READY with zeroed money", () => {
  const result = evaluateBillingReadiness({ contractStatus: "ACTIVE", payrollItems: [] });
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.estimatedRevenue, "0.00");
  assert.equal(result.estimatedMarginPercent, "0.00");
});

test("eligible items with none pending is READY_FOR_INVOICE, with correct Decimal-safe money", () => {
  const result = evaluateBillingReadiness({
    contractStatus: "ACTIVE",
    payrollItems: [
      { billAmount: 600, grossPay: 400, invoiced: false, payrollRunBillable: true },
      { billAmount: 300, grossPay: 200, invoiced: false, payrollRunBillable: true },
    ],
  });
  assert.equal(result.status, "READY_FOR_INVOICE");
  assert.equal(result.estimatedRevenue, "900.00");
  assert.equal(result.estimatedLaborCost, "600.00");
  assert.equal(result.estimatedGrossProfit, "300.00");
  assert.equal(result.estimatedMarginPercent, "33.33");
});

test("eligible items mixed with items still pending payroll approval routes to NEEDS_REVIEW (partial billing)", () => {
  const result = evaluateBillingReadiness({
    contractStatus: "ACTIVE",
    payrollItems: [
      { billAmount: 600, grossPay: 400, invoiced: false, payrollRunBillable: true },
      { billAmount: 300, grossPay: 200, invoiced: false, payrollRunBillable: false },
    ],
  });
  assert.equal(result.status, "NEEDS_REVIEW");
  // Solo el item elegible entra al cálculo de dinero -- el pendiente no se factura todavía.
  assert.equal(result.estimatedRevenue, "600.00");
});

test("no eligible items, but some still pending payroll approval, is NOT_READY (not EXPORTED)", () => {
  const result = evaluateBillingReadiness({
    contractStatus: "ACTIVE",
    payrollItems: [{ billAmount: 300, grossPay: 200, invoiced: false, payrollRunBillable: false }],
  });
  assert.equal(result.status, "NOT_READY");
});

test("no eligible items, all already invoiced, is EXPORTED", () => {
  const result = evaluateBillingReadiness({
    contractStatus: "ACTIVE",
    payrollItems: [{ billAmount: 600, grossPay: 400, invoiced: true, payrollRunBillable: true }],
  });
  assert.equal(result.status, "EXPORTED");
  // Los items ya facturados no cuentan como "elegibles" -- el dinero estimado refleja solo lo pendiente de facturar (cero acá).
  assert.equal(result.estimatedRevenue, "0.00");
});

test("zero revenue never divides by zero -- marginPercent is a clean 0.00, not NaN/Infinity", () => {
  const result = evaluateBillingReadiness({ contractStatus: "ACTIVE", payrollItems: [] });
  assert.equal(result.estimatedMarginPercent, "0.00");
});
