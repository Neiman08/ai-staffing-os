import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { computeContactCoverage } from "./ceo-tools.impl";

/**
 * F16 debt fix: computeContactCoverage antes buscaba AgentTask hijos de
 * type "find_contacts"/"find_email" -- tipos que este código nunca crea
 * (Contact Intelligence corre DENTRO de discover_companies desde F7.7,
 * sin task propio). Esto garantiza contra la regresión real: una misión
 * con Contacts reales creados NUNCA debe reportar companiesConsidered=0.
 */

const TEST_PREFIX = "CONTACT-COVERAGE-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const agentInstance = await prisma.agentInstance.create({
    data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true },
  });
  const industry = await prisma.industry.create({ data: { tenantId: tenant.id, name: "Construction", isGlobal: false } });
  return { tenantId: tenant.id, agentInstanceId: agentInstance.id, industryId: industry.id };
}

after(async () => {
  if (createdTenantIds.length === 0) return;
  await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.industry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
});

test("F16 debt fix: companias descubiertas por discover_companies con Contacts reales se cuentan -- nunca companiesConsidered=0 pese a contactos reales", async () => {
  const { tenantId, agentInstanceId, industryId } = await setupTenant("discover");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const missionTask = await prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "daily_revenue_mission", input: {}, status: "RUNNING", triggeredBy: "USER" },
    });
    const discoverTask = await prisma.agentTask.create({
      data: {
        tenantId,
        agentInstanceId,
        type: "discover_companies",
        status: "DONE",
        triggeredBy: "AGENT",
        parentTaskId: missionTask.id,
        input: {},
        output: {},
      },
    });
    const companyWithContact = await prisma.company.create({
      data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", discoveredByAgentTaskId: discoverTask.id },
    });
    const companyWithoutContact = await prisma.company.create({
      data: { tenantId, name: "Beta Electrical", industryId, status: "LEAD", discoveredByAgentTaskId: discoverTask.id },
    });
    await prisma.contact.create({
      data: {
        tenantId,
        companyId: companyWithContact.id,
        firstName: "Jane",
        lastName: "Doe",
        source: "Hunter.io",
      },
    });

    const coverage = await computeContactCoverage(missionTask.id);
    assert.equal(coverage.companiesConsidered, 2);
    assert.equal(coverage.companiesWithContactPoint, 1);
    assert.equal(coverage.companiesWithoutContactPoint, 1);
    void companyWithoutContact;
  });
});

test("F16 debt fix: companias del pipeline clásico (select_target_companies) también se cuentan", async () => {
  const { tenantId, agentInstanceId, industryId } = await setupTenant("classic");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const missionTask = await prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "daily_revenue_mission", input: {}, status: "RUNNING", triggeredBy: "USER" },
    });
    const company = await prisma.company.create({ data: { tenantId, name: "Gamma Electrical", industryId, status: "LEAD", email: "info@gamma.example" } });
    await prisma.agentTask.create({
      data: {
        tenantId,
        agentInstanceId,
        type: "select_target_companies",
        status: "DONE",
        triggeredBy: "AGENT",
        parentTaskId: missionTask.id,
        input: {},
        output: { companyIds: [company.id] },
      },
    });

    const coverage = await computeContactCoverage(missionTask.id);
    assert.equal(coverage.companiesConsidered, 1);
    // Company.email cuenta como punto de contacto real (organizacional), igual que un Contact nombrado.
    assert.equal(coverage.companiesWithContactPoint, 1);
    assert.equal(coverage.companiesWithoutContactPoint, 0);
  });
});

test("F16 debt fix: providersOmitted sale del discoveryExecution/discoveryFallback real de la misión, no de un task inexistente", async () => {
  const { tenantId, agentInstanceId, industryId } = await setupTenant("providers");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const missionTask = await prisma.agentTask.create({
      data: {
        tenantId,
        agentInstanceId,
        type: "daily_revenue_mission",
        input: {},
        status: "RUNNING",
        triggeredBy: "USER",
        output: { discoveryFallback: { providersOmitted: ["People Data Labs: CREDIT_EXHAUSTED"] } },
      },
    });
    const discoverTask = await prisma.agentTask.create({
      data: {
        tenantId,
        agentInstanceId,
        type: "discover_companies",
        status: "DONE",
        triggeredBy: "AGENT",
        parentTaskId: missionTask.id,
        input: {},
        output: {},
      },
    });
    await prisma.company.create({
      data: { tenantId, name: "Delta Electrical", industryId, status: "LEAD", discoveredByAgentTaskId: discoverTask.id },
    });

    const coverage = await computeContactCoverage(missionTask.id);
    assert.deepEqual(coverage.providersOmitted, ["People Data Labs: CREDIT_EXHAUSTED"]);
  });
});

test("sin ninguna compañía considerada, devuelve honestamente companiesConsidered=0 (caso real, no un bug)", async () => {
  const { tenantId, agentInstanceId } = await setupTenant("empty");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const missionTask = await prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "daily_revenue_mission", input: {}, status: "RUNNING", triggeredBy: "USER" },
    });
    const coverage = await computeContactCoverage(missionTask.id);
    assert.deepEqual(coverage, { companiesConsidered: 0, companiesWithContactPoint: 0, companiesWithoutContactPoint: 0, providersOmitted: [] });
  });
});
