// F11.6: GET /analytics/financial -- margen día por día, antigüedad de
// facturas, costo de payroll. Field-level por permiso real (payrollRuns.
// view || invoices.view para el bloque general, invoices.view para
// invoiceAging, payrollRuns.view para payrollCost), mismo criterio F6.8.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface FinancialBody {
  generatedAt: string;
  financial: {
    period?: { from: string; to: string };
    marginTrend?: Array<{ date: string; hours: number; margin: number }>;
    invoiceAging?: { current: string; days31to60: string; days61to90: string; over90: string; totalOutstanding: string };
    payrollCost?: { totalGross: string; totalBill: string; totalMargin: string; runsIncluded: number };
  };
}

async function fetchFinancial(devUser: string, qs = ""): Promise<{ status: number; body: FinancialBody }> {
  const res = await fetch(`${baseUrl}/api/v1/analytics/financial${qs}`, { headers: { "x-dev-user": devUser } });
  const body = (await res.json()) as FinancialBody;
  return { status: res.status, body };
}

test("accounting@titan.dev (payrollRuns.view + invoices.view): ve marginTrend, invoiceAging y payrollCost completos", async () => {
  const { status, body } = await fetchFinancial("accounting@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.financial.marginTrend !== undefined);
  assert.ok(body.financial.invoiceAging);
  assert.ok(body.financial.payrollCost);
  assert.ok(body.financial.payrollCost!.runsIncluded >= 0);
});

test("payroll@titan.dev (payrollRuns.view sin invoices.view): marginTrend y payrollCost presentes, invoiceAging ausente", async () => {
  const { status, body } = await fetchFinancial("payroll@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.financial.marginTrend !== undefined);
  assert.ok(body.financial.payrollCost);
  assert.equal(body.financial.invoiceAging, undefined);
});

test("manager@titan.dev (invoices.view sin payrollRuns.view): marginTrend e invoiceAging presentes, payrollCost ausente", async () => {
  const { status, body } = await fetchFinancial("manager@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.financial.marginTrend !== undefined);
  assert.ok(body.financial.invoiceAging);
  assert.equal(body.financial.payrollCost, undefined);
});

test("recruiter@titan.dev (sin payrollRuns.view ni invoices.view): financial queda vacío, nunca 403", async () => {
  const { status, body } = await fetchFinancial("recruiter@titan.dev");
  assert.equal(status, 200);
  assert.deepEqual(body.financial, {});
});

test("invoiceAging: totalOutstanding = current + days31to60 + days61to90 + over90 (mismo balance, distinto bucket)", async () => {
  const { body } = await fetchFinancial("accounting@titan.dev");
  const aging = body.financial.invoiceAging!;
  const sum = Number(aging.current) + Number(aging.days31to60) + Number(aging.days61to90) + Number(aging.over90);
  // Diferencia posible solo por facturas sin dueDate real (cuentan en
  // totalOutstanding pero en ningún bucket) -- nunca el sum puede superar el total.
  assert.ok(sum <= Number(aging.totalOutstanding) + 0.01);
});

test("filtro from/to real: rango sin ningún PayrollRun/TimeEntry -> ceros, nunca error", async () => {
  const { status, body } = await fetchFinancial("accounting@titan.dev", "?from=2010-01-01&to=2010-01-02");
  assert.equal(status, 200);
  assert.deepEqual(body.financial.marginTrend, []);
  assert.deepEqual(body.financial.payrollCost, { totalGross: "0.00", totalBill: "0.00", totalMargin: "0.00", runsIncluded: 0 });
});

test("ninguna identidad de portal puede alcanzar /analytics/financial", async () => {
  for (const devUser of ["worker-portal@titan.dev", "candidate-portal@titan.dev", "client-admin@titan.dev"]) {
    const { status } = await fetchFinancial(devUser);
    assert.equal(status, 403, `${devUser} debería recibir 403`);
  }
});

test("query inválida devuelve 400, no 500", async () => {
  const res = await fetch(`${baseUrl}/api/v1/analytics/financial?from=not-a-date`, {
    headers: { "x-dev-user": "accounting@titan.dev" },
  });
  assert.equal(res.status, 400);
});
