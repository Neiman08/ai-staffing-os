import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { env } from "../../core/env";
import { getPdlMonthlyBudgetStatus, createPdlMissionBudget, consumePdlMissionBudget, computeAllowedPdlSearchSize } from "./pdl-budget";

/**
 * F27 Fase 6: hallazgo real de esta misión -- un HTTP 402 de PDL pese a
 * ~15 créditos "restantes" según el panel, porque una sola Company con
 * varios roles objetivo ya pedía hasta 20 registros de una vez. Estas
 * pruebas cubren los 2 mecanismos nuevos: el techo mensual persistido
 * (derivado de AgentTask.costUsd real, sin ninguna llamada nueva a PDL) y
 * el techo de una misión en memoria, y que ambos, más el techo fijo por
 * empresa, se combinan correctamente en computeAllowedPdlSearchSize.
 */

const TEST_PREFIX = "F27-PDL-BUDGET-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function seedFindContactsTask(tenantId: string, costUsd: number): Promise<void> {
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const agentInstance = await prisma.agentInstance.create({ data: { tenantId, definitionId: discoveryDefinition.id, isActive: true } });
  await prisma.agentTask.create({
    data: { tenantId, agentInstanceId: agentInstance.id, type: "find_contacts", status: "DONE", triggeredBy: "AGENT", input: {}, costUsd },
  });
}

test("getPdlMonthlyBudgetStatus: sin ningún find_contacts este mes, remainingThisMonth = presupuesto completo", async () => {
  const tenantId = await setupTenant("no-spend-yet");
  const status = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getPdlMonthlyBudgetStatus(tenantId));

  assert.equal(status.creditsUsedThisMonth, 0);
  assert.equal(status.monthlyCreditBudget, env.PDL_MONTHLY_CREDIT_BUDGET);
  assert.equal(status.remainingThisMonth, env.PDL_MONTHLY_CREDIT_BUDGET);
});

test("getPdlMonthlyBudgetStatus: deriva créditos reales del costUsd acumulado de find_contacts este mes", async () => {
  const tenantId = await setupTenant("real-spend");
  // 0.05 USD por match (COST_PER_MATCH_USD, ver people-data-labs.ts) --
  // 10 créditos reales gastados este mes.
  await seedFindContactsTask(tenantId, 0.5);

  const status = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getPdlMonthlyBudgetStatus(tenantId));

  assert.equal(status.creditsUsedThisMonth, 10);
  assert.equal(status.remainingThisMonth, env.PDL_MONTHLY_CREDIT_BUDGET - 10);
});

test("getPdlMonthlyBudgetStatus: nunca da un remainingThisMonth negativo cuando el gasto real superó el presupuesto", async () => {
  const tenantId = await setupTenant("overspent");
  await seedFindContactsTask(tenantId, (env.PDL_MONTHLY_CREDIT_BUDGET + 20) * 0.05);

  const status = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getPdlMonthlyBudgetStatus(tenantId));

  assert.ok(status.creditsUsedThisMonth > env.PDL_MONTHLY_CREDIT_BUDGET);
  assert.equal(status.remainingThisMonth, 0);
});

test("getPdlMonthlyBudgetStatus: nunca mezcla el gasto de OTRO tenant", async () => {
  const tenantA = await setupTenant("isolation-a");
  const tenantB = await setupTenant("isolation-b");
  await seedFindContactsTask(tenantB, 5); // 100 créditos reales en tenantB

  const statusA = await runWithTenancyContext({ tenantId: tenantA, userId: "test-user", permissions: [] }, () => getPdlMonthlyBudgetStatus(tenantA));

  assert.equal(statusA.creditsUsedThisMonth, 0, "el gasto de otro tenant nunca debe contarse acá");
});

test("createPdlMissionBudget/consumePdlMissionBudget: descuenta créditos reales y nunca baja de 0", () => {
  const budget = createPdlMissionBudget(10);
  assert.equal(budget.remaining, 10);

  consumePdlMissionBudget(budget, 4);
  assert.equal(budget.remaining, 6);

  consumePdlMissionBudget(budget, 100);
  assert.equal(budget.remaining, 0, "nunca debe quedar negativo aunque se consuma de más");
});

test("computeAllowedPdlSearchSize: el mínimo real entre lo pedido, el techo por empresa, la misión y el mes", () => {
  const missionBudget = createPdlMissionBudget(3);
  const allowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining: 100 });

  // env.PDL_PER_COMPANY_MAX_RESULTS default = 5, pero missionBudget.remaining = 3 es el más chico de los 4.
  assert.equal(allowed, 3);
});

test("computeAllowedPdlSearchSize: 0 cuando el mes ya se agotó, sin importar que la misión tenga saldo", () => {
  const missionBudget = createPdlMissionBudget(10);
  const allowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining: 0 });

  assert.equal(allowed, 0);
});

test("computeAllowedPdlSearchSize: el techo fijo por empresa nunca se supera aunque la misión y el mes tengan saldo de sobra", () => {
  const missionBudget = createPdlMissionBudget(1000);
  const allowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining: 1000 });

  assert.equal(allowed, env.PDL_PER_COMPANY_MAX_RESULTS);
});

test("un presupuesto de misión compartido entre varias empresas nunca deja que la suma de todas supere el techo de la misión", () => {
  const missionBudget = createPdlMissionBudget(7);
  const monthlyRemaining = 1000;

  const firstCompanyAllowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining });
  consumePdlMissionBudget(missionBudget, firstCompanyAllowed);

  const secondCompanyAllowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining });
  consumePdlMissionBudget(missionBudget, secondCompanyAllowed);

  const thirdCompanyAllowed = computeAllowedPdlSearchSize({ requestedSize: 20, missionBudget, monthlyRemaining });

  assert.equal(firstCompanyAllowed + secondCompanyAllowed, 7);
  assert.equal(thirdCompanyAllowed, 0, "la tercera empresa no debe recibir nada -- la misión ya se agotó entre las 2 primeras");
});
