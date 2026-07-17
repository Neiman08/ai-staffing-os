import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { enrichCompanyWithDecisionContacts, type ContactProviderPort } from "./contact-enrichment";
import type { DecisionRolePlan } from "../ceo-intelligence/role-planning";
import { emptyContactResult } from "./tools/contact-providers/types";
import type { ContactCandidate } from "./tools/contact-providers/types";

/**
 * F7.7: tests de la integración impura People Data Labs + rolePlan
 * (F7.6) + Contact. Cero llamadas de red reales -- searchPeopleDataLabs
 * siempre se inyecta como fake vía el parámetro `contactProvider`.
 * Guardia extra: global.fetch sobreescrito para que cualquier intento
 * accidental de red real explote el test.
 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("contact-enrichment.test.ts: intento de llamada de red real — People Data Labs debe inyectarse mockeada.");
}) as typeof fetch;

const TEST_PREFIX = "F77-CONTACTS-TEST";
const createdTenantIds: string[] = [];
const createdCompanyIds: string[] = [];

async function setupTenantWithCompany(suffix: string): Promise<{ tenantId: string; companyId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing" } });
  const company = await runWithTenancyContext({ tenantId: tenant.id, userId: "setup", permissions: [] }, () =>
    prisma.company.create({
      data: { tenantId: tenant.id, name: "Acme Manufacturing", industryId: industry.id, status: "LEAD", website: "https://acme-mfg.com" },
    }),
  );
  createdCompanyIds.push(company.id);
  return { tenantId: tenant.id, companyId: company.id };
}

after(async () => {
  globalThis.fetch = originalFetch;
  if (createdCompanyIds.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdCompanyIds } } });
  }
  if (createdTenantIds.length) {
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function candidateFixture(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    firstName: "Jane",
    lastName: "Doe",
    title: "HR Manager",
    fields: {
      firstName: { status: "CONFIRMED", value: "Jane" },
      lastName: { status: "CONFIRMED", value: "Doe" },
      title: { status: "CONFIRMED", value: "HR Manager" },
      linkedinUrl: { status: "NOT_FOUND", value: null },
      email: { status: "NOT_FOUND", value: null },
      phone: { status: "NOT_FOUND", value: null },
    },
    sourceUrl: null,
    ...overrides,
  };
}

function rolePlanFixture(companyId: string, overrides: Partial<DecisionRolePlan> = {}): DecisionRolePlan {
  return {
    companyId,
    targetRoles: [{ role: "HR Manager", priority: 1, rationale: "test", source: "intent" }],
    excludedRoles: [],
    confidence: 0.9,
    taxonomySource: "manufacturing",
    hiringSignalSource: null,
    planVersion: 1,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<ContactProviderPort> = {}): ContactProviderPort {
  return {
    searchPeopleDataLabs: async () => emptyContactResult(),
    ...overrides,
  };
}

async function run(tenantId: string, companyId: string, rolePlan: DecisionRolePlan | null, provider: ContactProviderPort) {
  return runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    enrichCompanyWithDecisionContacts({
      taskId: "test-task",
      companyId,
      companyName: "Acme Manufacturing",
      companyWebsite: "https://acme-mfg.com",
      companyState: "IL",
      companyCity: "Chicago",
      industryName: "Manufacturing",
      rolePlan,
      contactProvider: provider,
      peopleDataLabsApiKey: "fake-key-for-tests",
    }),
  );
}

test("rolePlan null: no llama al proveedor, reporte vacío honesto", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-roleplan");
  let called = false;
  const report = await run(tenantId, companyId, null, fakeProvider({ searchPeopleDataLabs: async () => { called = true; return emptyContactResult(); } }));
  assert.equal(called, false);
  assert.equal(report.candidatesFound, 0);
  assert.ok(report.patternsFailed[0]!.includes("sin roles planificados"));
});

test("rolePlan sin targetRoles: no llama al proveedor", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("empty-roleplan");
  let called = false;
  const report = await run(
    tenantId,
    companyId,
    rolePlanFixture(companyId, { targetRoles: [] }),
    fakeProvider({ searchPeopleDataLabs: async () => { called = true; return emptyContactResult(); } }),
  );
  assert.equal(called, false);
  assert.equal(report.candidatesFound, 0);
});

test("sin PEOPLEDATALABS_API_KEY: no llama al proveedor, motivo honesto en patternsFailed", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-api-key");
  let called = false;
  const report = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    enrichCompanyWithDecisionContacts({
      taskId: "test-task",
      companyId,
      companyName: "Acme Manufacturing",
      companyWebsite: "https://acme-mfg.com",
      companyState: "IL",
      companyCity: "Chicago",
      industryName: "Manufacturing",
      rolePlan: rolePlanFixture(companyId),
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => { called = true; return emptyContactResult(); } }),
      // Cadena vacía (falsy) en vez de undefined: undefined caería al
      // fallback real de env.PEOPLEDATALABS_API_KEY, que SÍ está
      // configurada en este entorno de desarrollo -- este test verifica
      // específicamente el camino "sin key", determinista sin importar
      // el .env real.
      peopleDataLabsApiKey: "",
    }),
  );
  assert.equal(called, false);
  assert.ok(report.patternsFailed[0]!.includes("PEOPLEDATALABS_API_KEY"));
  assert.deepEqual(report.rolesWithoutContact, ["HR Manager"]);
});

test("candidato con email de dominio oficial: emailDomainTrust VERIFIED, nunca crea CompanyContactPoint", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("domain-verified");
  const report = await run(
    tenantId,
    companyId,
    rolePlanFixture(companyId),
    fakeProvider({
      searchPeopleDataLabs: async () => ({
        candidates: [candidateFixture({ fields: { ...candidateFixture().fields, email: { status: "CONFIRMED", value: "jane.doe@acme-mfg.com" } } })],
        costUsd: 0.05,
        sourcesUsed: ["People Data Labs (test)"],
        patternsFailed: [],
        cancelled: false,
        providerStatus: "AVAILABLE",
      }),
    }),
  );
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.emailDomainTrust, "VERIFIED");
  const contactPoints = await prisma.companyContactPoint.count({ where: { companyId } });
  assert.equal(contactPoints, 0);
});

test("candidato con email de dominio ajeno: emailDomainTrust INVALID, el Contact igual se crea (el nombre es real, el email se reporta honestamente)", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("domain-invalid");
  const report = await run(
    tenantId,
    companyId,
    rolePlanFixture(companyId),
    fakeProvider({
      searchPeopleDataLabs: async () => ({
        candidates: [candidateFixture({ fields: { ...candidateFixture().fields, email: { status: "CONFIRMED", value: "jane.doe@totally-different-company.com" } } })],
        costUsd: 0.05,
        sourcesUsed: ["People Data Labs (test)"],
        patternsFailed: [],
        cancelled: false,
        providerStatus: "AVAILABLE",
      }),
    }),
  );
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.emailDomainTrust, "INVALID");
});

test("cancelación se propaga honestamente, sin crear ningún Contact", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cancelled");
  const report = await run(
    tenantId,
    companyId,
    rolePlanFixture(companyId),
    fakeProvider({ searchPeopleDataLabs: async () => ({ candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: ["cancelled by user"], cancelled: true, providerStatus: "AVAILABLE" }) }),
  );
  assert.equal(report.cancelled, true);
  assert.equal(report.contactsCreated.length, 0);
  const contacts = await prisma.contact.count({ where: { companyId } });
  assert.equal(contacts, 0);
});

test("nunca crea Lead/Opportunity/Campaign — solo Contact", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("no-side-effects");
  await run(
    tenantId,
    companyId,
    rolePlanFixture(companyId),
    fakeProvider({
      searchPeopleDataLabs: async () => ({ candidates: [candidateFixture()], costUsd: 0.05, sourcesUsed: ["People Data Labs (test)"], patternsFailed: [], cancelled: false, providerStatus: "AVAILABLE" }),
    }),
  );
  const [leads, opportunities, campaigns] = await Promise.all([
    prisma.lead.count({ where: { companyId } }),
    prisma.opportunity.count({ where: { companyId } }),
    prisma.campaign.count({ where: { tenantId } }),
  ]);
  assert.equal(leads, 0);
  assert.equal(opportunities, 0);
  assert.equal(campaigns, 0);
});

test("tenancy: los Contact creados en un tenant no son visibles desde otro", async () => {
  const { tenantId: tenantA, companyId } = await setupTenantWithCompany("tenancy-a");
  await run(
    tenantA,
    companyId,
    rolePlanFixture(companyId),
    fakeProvider({
      searchPeopleDataLabs: async () => ({ candidates: [candidateFixture()], costUsd: 0.05, sourcesUsed: ["People Data Labs (test)"], patternsFailed: [], cancelled: false, providerStatus: "AVAILABLE" }),
    }),
  );
  const { tenantId: tenantB } = await setupTenantWithCompany("tenancy-b");
  const visibleFromB = await runWithTenancyContext({ tenantId: tenantB, userId: "u", permissions: [] }, () =>
    prisma.contact.findMany({ where: { tenantId: tenantB, firstName: "Jane", lastName: "Doe" } }),
  );
  assert.equal(visibleFromB.length, 0);
});
