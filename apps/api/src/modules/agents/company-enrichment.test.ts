import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { emptyWebsiteIntelligenceResult, type WebsiteIntelligenceResult } from "./tools/website-intelligence/types";
import { enrichCompanyWithOrganizationalEmails, type WebsiteIntelligencePort } from "./company-enrichment";

/**
 * F7.4 Parte B: tests de la integración impura Website Intelligence +
 * email-trust.ts + CompanyContactPoint. Cero llamadas de red reales --
 * runWebsiteIntelligence siempre se inyecta como fake vía el parámetro
 * `websiteIntelligence`. Guardia extra: global.fetch sobreescrito para
 * que cualquier intento accidental de red real explote el test.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("company-enrichment.test.ts: intento de llamada de red real — Website Intelligence debe inyectarse mockeada.");
}) as typeof fetch;

const TEST_PREFIX = "F74-ENRICH-TEST";
const createdTenantIds: string[] = [];
const createdCompanyIds: string[] = [];

async function setupTenantWithCompany(suffix: string, website: string | null, existingEmail: string | null = null): Promise<{ tenantId: string; companyId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const company = await runWithTenancyContext({ tenantId: tenant.id, userId: "setup", permissions: [] }, () =>
    prisma.company.create({
      data: { tenantId: tenant.id, name: "Acme Manufacturing", industryId: industry.id, status: "LEAD", website, email: existingEmail },
    }),
  );
  createdCompanyIds.push(company.id);
  return { tenantId: tenant.id, companyId: company.id };
}

after(async () => {
  globalThis.fetch = originalFetch;
  if (createdCompanyIds.length) {
    await prisma.companyContactPoint.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdCompanyIds } } });
  }
  if (createdTenantIds.length) {
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function fakePort(result: WebsiteIntelligenceResult): WebsiteIntelligencePort {
  return { runWebsiteIntelligence: async () => result };
}

async function run(tenantId: string, companyId: string, port: WebsiteIntelligencePort) {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    enrichCompanyWithOrganizationalEmails({ taskId: "test-task", companyId, websiteIntelligence: port }),
  );
}

test("Company sin website: no llama a Website Intelligence, reporte vacío honesto", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-website", null);
  const report = await run(tenantId, companyId, fakePort(emptyWebsiteIntelligenceResult()));
  assert.equal(report.emailsExtracted, 0);
  assert.ok(report.patternsFailed[0]!.includes("sin website"));
});

test("email con dominio oficial (VERIFIED) se persiste como CompanyContactPoint y actualiza Company.email vacío", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("verified-flow", "https://acme-mfg.com");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "info@acme-mfg.com", sourceUrl: "https://acme-mfg.com/contact" }],
    pagesVisited: ["https://acme-mfg.com", "https://acme-mfg.com/contact"],
  };
  const report = await run(tenantId, companyId, fakePort(result));

  assert.equal(report.emailsExtracted, 1);
  assert.equal(report.emailsVerified, 1);
  assert.equal(report.companyContactPointsCreated, 1);
  assert.equal(report.companyEmailUpdated, true);

  const points = await runWithTenancyContext({ tenantId, userId: "check", permissions: [] }, () =>
    prisma.companyContactPoint.findMany({ where: { companyId } }),
  );
  assert.equal(points.length, 1);
  assert.equal(points[0]!.email, "info@acme-mfg.com");
  assert.equal(points[0]!.verificationStatus, "VERIFIED");
  assert.equal(points[0]!.type, "INFO");

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  assert.equal(company.email, "info@acme-mfg.com");
});

test("email con dominio ajeno (INVALID) nunca se persiste como CompanyContactPoint ni actualiza Company.email — el bug real del PO", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("collegefencing-case", "https://generalmanufacturing.net");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "editor@collegefencing360.com", sourceUrl: "https://some-random-page.com/article" }],
  };
  const report = await run(tenantId, companyId, fakePort(result));

  assert.equal(report.emailsInvalid, 1);
  assert.equal(report.companyContactPointsCreated, 0);
  assert.equal(report.companyEmailUpdated, false);

  const points = await prisma.companyContactPoint.findMany({ where: { companyId } });
  assert.equal(points.length, 0);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  assert.equal(company.email, null);
});

test("email de proveedor gratuito (RISKY) se persiste, pero nunca actualiza Company.email", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("risky-flow", "https://acme-mfg.com");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "owner@gmail.com", sourceUrl: "https://acme-mfg.com/contact" }],
  };
  const report = await run(tenantId, companyId, fakePort(result));

  assert.equal(report.emailsRisky, 1);
  assert.equal(report.companyContactPointsCreated, 1);
  assert.equal(report.companyEmailUpdated, false, "un email RISKY nunca actualiza Company.email, solo VERIFIED");

  const points = await prisma.companyContactPoint.findMany({ where: { companyId } });
  assert.equal(points.length, 1);
  assert.equal(points[0]!.verificationStatus, "RISKY");

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  assert.equal(company.email, null);
});

test("Company.email ya existente nunca se sobrescribe, aunque se encuentre un email VERIFIED nuevo", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-overwrite", "https://acme-mfg.com", "already@acme-mfg.com");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "sales@acme-mfg.com", sourceUrl: "https://acme-mfg.com/contact" }],
  };
  const report = await run(tenantId, companyId, fakePort(result));

  assert.equal(report.emailsVerified, 1);
  assert.equal(report.companyContactPointsCreated, 1, "el CompanyContactPoint SÍ se crea aunque Company.email no cambie");
  assert.equal(report.companyEmailUpdated, false);

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  assert.equal(company.email, "already@acme-mfg.com");
});

test("emails duplicados (mismo email en 2 páginas) se deduplican, un solo CompanyContactPoint", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("dedup-flow", "https://acme-mfg.com");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [
      { email: "info@acme-mfg.com", sourceUrl: "https://acme-mfg.com" },
      { email: "INFO@acme-mfg.com", sourceUrl: "https://acme-mfg.com/contact" },
    ],
  };
  const report = await run(tenantId, companyId, fakePort(result));
  assert.equal(report.emailsExtracted, 1);
  assert.equal(report.companyContactPointsCreated, 1);
});

test("correr la misma enriquecimiento dos veces no duplica el CompanyContactPoint (idempotente)", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("idempotent-flow", "https://acme-mfg.com");
  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "info@acme-mfg.com", sourceUrl: "https://acme-mfg.com" }],
  };
  const first = await run(tenantId, companyId, fakePort(result));
  const second = await run(tenantId, companyId, fakePort(result));

  assert.equal(first.companyContactPointsCreated, 1);
  assert.equal(second.companyContactPointsCreated, 0, "la segunda corrida no debe re-crear el mismo punto de contacto");

  const points = await prisma.companyContactPoint.findMany({ where: { companyId } });
  assert.equal(points.length, 1);
});

test("nunca crea Contact/Lead/Opportunity/Campaign — solo CompanyContactPoint y opcionalmente Company.email", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-side-effects", "https://acme-mfg.com");
  const [contactsBefore, leadsBefore, oppsBefore, campaignsBefore] = await Promise.all([
    prisma.contact.count({ where: { tenantId } }),
    prisma.lead.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
  ]);

  const result: WebsiteIntelligenceResult = {
    ...emptyWebsiteIntelligenceResult(),
    genericEmails: [{ email: "hr@acme-mfg.com", sourceUrl: "https://acme-mfg.com/careers" }],
    namedPeople: [{ firstName: "Jane", lastName: "Doe", title: "HR Manager", email: "jane@acme-mfg.com", sourceUrl: "https://acme-mfg.com/team" }],
  };
  await run(tenantId, companyId, fakePort(result));

  const [contactsAfter, leadsAfter, oppsAfter, campaignsAfter] = await Promise.all([
    prisma.contact.count({ where: { tenantId } }),
    prisma.lead.count({ where: { tenantId } }),
    prisma.opportunity.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
  ]);
  assert.equal(contactsAfter, contactsBefore, "namedPeople nunca crea Contact — Contact Intelligence no corre en F7.4");
  assert.equal(leadsAfter, leadsBefore);
  assert.equal(oppsAfter, oppsBefore);
  assert.equal(campaignsAfter, campaignsBefore);

  const points = await prisma.companyContactPoint.findMany({ where: { companyId } });
  assert.equal(points.length, 1, "solo el genericEmail se procesa, jane@acme-mfg.com (namedPeople) se ignora");
  assert.equal(points[0]!.email, "hr@acme-mfg.com");
});

test("cancelación de Website Intelligence se propaga honestamente, sin persistir nada", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cancelled-flow", "https://acme-mfg.com");
  const result: WebsiteIntelligenceResult = { ...emptyWebsiteIntelligenceResult(), cancelled: true, patternsFailed: ["cancelled by user"] };
  const report = await run(tenantId, companyId, fakePort(result));
  assert.equal(report.cancelled, true);
  assert.equal(report.companyContactPointsCreated, 0);
});

test("tenancy: los CompanyContactPoint creados en un tenant no son visibles desde otro", async () => {
  const a = await setupTenantWithCompany("tenancy-a", "https://acme-mfg.com");
  const b = await setupTenantWithCompany("tenancy-b", "https://other-corp.com");
  const result: WebsiteIntelligenceResult = { ...emptyWebsiteIntelligenceResult(), genericEmails: [{ email: "info@acme-mfg.com", sourceUrl: "https://acme-mfg.com" }] };
  await run(a.tenantId, a.companyId, fakePort(result));

  const visibleFromB = await runWithTenancyContext({ tenantId: b.tenantId, userId: "u", permissions: [] }, () =>
    prisma.companyContactPoint.findMany({ where: { tenantId: b.tenantId } }),
  );
  assert.equal(visibleFromB.length, 0);
});
