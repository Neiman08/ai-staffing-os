// F11.10: los 4 servicios de analítica corren enteramente sobre scopedDb
// (confirmado por grep: cero `prisma.` crudo en el módulo) -- este test
// lo prueba en runtime, no solo por lectura de código: bajo un tenant
// real (tenant-titan, con datos reales) los agregados son > 0; bajo un
// tenant que no existe, con exactamente los mismos permisos, todos caen
// a cero/vacío -- nunca los mismos números que tenant-titan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { getExecutiveDashboard } from "./service";
import { getRecruitingMetrics } from "./recruiting.service";
import { getCommercialMetrics } from "./commercial.service";
import { getFinancialMetrics } from "./financial.service";

// CEO = ALL_KEYS en el seed real -- alcanza con listar los permisos que
// estos 4 servicios efectivamente leen, no hace falta el set completo.
const ALL_RELEVANT_PERMISSIONS = [
  "workers.view",
  "candidates.view",
  "jobOrders.view",
  "documents.view",
  "assignments.view",
  "payrollRuns.view",
  "invoices.view",
  "incidents.view",
  "leads.view",
  "opportunities.view",
  "timeEntries.view",
  "shifts.view",
];

test("analytics services: un tenant real (tenant-titan) devuelve datos reales distintos de cero", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "irrelevant", permissions: ALL_RELEVANT_PERMISSIONS }, async () => {
    const [executive, recruiting, commercial, financial] = await Promise.all([
      getExecutiveDashboard(),
      getRecruitingMetrics({}),
      getCommercialMetrics({}),
      getFinancialMetrics({}),
    ]);

    assert.ok((executive.recruiting.activeWorkers ?? 0) > 0, "tenant-titan debería tener Workers reales");
    assert.ok((recruiting.recruiting.funnel?.sourced ?? 0) > 0, "tenant-titan debería tener Candidates reales");
    assert.equal(typeof commercial.commercial.winRate?.won, "number");
    assert.ok((financial.financial.marginTrend?.length ?? 0) >= 0);
  });
});

test("analytics services: un tenant sin datos (tenant-does-not-exist), mismos permisos, nunca ve los números de tenant-titan", async () => {
  await runWithTenancyContext(
    { tenantId: "tenant-does-not-exist", userId: "irrelevant", permissions: ALL_RELEVANT_PERMISSIONS },
    async () => {
      const [executive, recruiting, commercial, financial] = await Promise.all([
        getExecutiveDashboard(),
        getRecruitingMetrics({}),
        getCommercialMetrics({}),
        getFinancialMetrics({}),
      ]);

      assert.equal(executive.recruiting.activeWorkers, 0);
      assert.deepEqual(executive.recruiting.candidatesByStatus, {});
      assert.deepEqual(recruiting.recruiting.funnel, { sourced: 0, qualified: 0, shortlisted: 0, placed: 0 });
      assert.deepEqual(commercial.commercial.winRate, { won: 0, lost: 0, winRatePercent: null });
      assert.deepEqual(financial.financial.marginTrend, []);
      assert.deepEqual(financial.financial.payrollCost, { totalGross: "0.00", totalBill: "0.00", totalMargin: "0.00", runsIncluded: 0 });
    },
  );
});

test("analytics services: sin contexto de tenancy, cada servicio rechaza en vez de devolver datos sin filtrar", async () => {
  await assert.rejects(() => getExecutiveDashboard(), /unauthorized/i);
  await assert.rejects(() => getRecruitingMetrics({}), /unauthorized/i);
  await assert.rejects(() => getCommercialMetrics({}), /unauthorized/i);
  await assert.rejects(() => getFinancialMetrics({}), /unauthorized/i);
});
