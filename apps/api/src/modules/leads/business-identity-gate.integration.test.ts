import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import * as leadsService from "./service";
import * as opportunitiesService from "../opportunities/service";

/**
 * F18: el gate de identidad de negocio (conversion-policy.ts,
 * evaluateBusinessIdentityGate) tiene que aplicarse en el punto REAL de
 * creación de Lead/Opportunity -- estas pruebas lo verifican contra la
 * base de datos real (no contra la función pura sola), para atrapar
 * cualquier caller futuro que intente crear un Lead/Opportunity sin
 * pasar por leadsService/opportunitiesService. Hallazgo real que motiva
 * esto: mission-orchestrator.ts y campaign-tools.impl.ts confiaban
 * ciegamente en Company.industryId sin volver a validar nada.
 */

const TEST_PREFIX = "F18-GATE-TEST";
const createdTenantIds: string[] = [];
const createdCompanyIds: string[] = [];

after(async () => {
  if (createdCompanyIds.length) {
    await prisma.lead.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  }
  if (createdTenantIds.length) {
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenantWithCompany(suffix: string, commercialStatus: "DISCOVERY_CANDIDATE" | "COMMERCIAL_VALIDATED") {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.findFirst({ where: { name: "Hospitality" } });
  assert.ok(industry, "Industry 'Hospitality' debe existir (seed global) para este test");

  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: `${TEST_PREFIX}-${suffix}-Company`,
      industryId: industry!.id,
      status: "LEAD",
      commercialStatus,
    },
  });
  createdCompanyIds.push(company.id);
  return { tenantId: tenant.id, companyId: company.id };
}

test("leadsService.createLead RECHAZA una Company DISCOVERY_CANDIDATE (candidato de Discovery sin validar)", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("lead-weak", "DISCOVERY_CANDIDATE");
  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["leads.create"] }, async () => {
    await assert.rejects(
      () => leadsService.createLead({ companyId, source: "test" } as never),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});

test("leadsService.createLead PERMITE una Company COMMERCIAL_VALIDATED", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("lead-validated", "COMMERCIAL_VALIDATED");
  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["leads.create"] }, async () => {
    const lead = await leadsService.createLead({ companyId, source: "test" } as never);
    assert.ok(lead.id);
  });
});

test("opportunitiesService.createOpportunity RECHAZA una Company DISCOVERY_CANDIDATE", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("opp-weak", "DISCOVERY_CANDIDATE");
  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["opportunities.create"] }, async () => {
    await assert.rejects(
      () => opportunitiesService.createOpportunity({ companyId, title: "Test Opportunity" } as never),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});

test("opportunitiesService.createOpportunity PERMITE una Company COMMERCIAL_VALIDATED", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("opp-validated", "COMMERCIAL_VALIDATED");
  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["opportunities.create"] }, async () => {
    const opportunity = await opportunitiesService.createOpportunity({ companyId, title: "Test Opportunity" } as never);
    assert.ok(opportunity.id);
  });
});

test("leadsService.convertLead RECHAZA convertir un Lead cuya Company (existente) es DISCOVERY_CANDIDATE", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("convert-weak", "DISCOVERY_CANDIDATE");
  await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["leads.create"] }, async () => {
    const lead = await prisma.lead.create({ data: { tenantId, companyId, status: "NEW" } });
    await assert.rejects(
      () =>
        leadsService.convertLead(lead.id, {
          opportunity: { title: "Test Opportunity" },
        } as never),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});
