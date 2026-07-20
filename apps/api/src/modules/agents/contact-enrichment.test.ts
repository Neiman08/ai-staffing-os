import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { enrichCompanyWithDecisionContacts, type ContactProviderPort, type HunterContactProviderPort } from "./contact-enrichment";
import type { DecisionRolePlan } from "../ceo-intelligence/role-planning";
import { emptyContactResult } from "./tools/contact-providers/types";
import type { ContactCandidate } from "./tools/contact-providers/types";
import { emptyEmailResult } from "./tools/email-providers/types";
import type { EmailCandidate } from "./tools/email-providers/types";
import type { WebsiteNamedPerson } from "./tools/website-intelligence/types";

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
      // F15: este helper prueba EXCLUSIVAMENTE la fuente 1 (PDL) --
      // "" evita que un rolesWithoutContact no vacío dispare la cascada
      // real hacia Hunter (HUNTER_API_KEY sí está configurada en este
      // entorno de desarrollo). Los tests dedicados de la cascada
      // (F15, más abajo) pasan sus propios overrides explícitos.
      hunterApiKey: "",
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
      // F15: sin roles cubiertos tras PDL, la cascada seguiría hacia
      // Hunter -- mismo criterio, "" fuerza el camino "sin key" en vez
      // de caer al HUNTER_API_KEY real de este entorno (que SÍ dispararía
      // una llamada de red real, atrapada por el guard de este archivo
      // solo después de 3 reintentos con backoff -- lento e indeseado).
      hunterApiKey: "",
    }),
  );
  assert.equal(called, false);
  assert.ok(report.patternsFailed[0]!.includes("PEOPLEDATALABS_API_KEY"));
  assert.ok(report.patternsFailed.some((p) => p.includes("HUNTER_API_KEY")));
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

  // F7.8: buena evidencia (email de dominio propio, rol de prioridad
  // máxima) -> ranking persistido y consistente con lo devuelto en el
  // reporte -- nunca decidido por un LLM.
  assert.equal(report.contactsCreated[0]!.rankingTier, "HIGH_CONFIDENCE");
  const contactRow = await prisma.contact.findUniqueOrThrow({ where: { id: report.contactsCreated[0]!.contactId } });
  assert.equal(contactRow.rankingTier, "HIGH_CONFIDENCE");
  assert.equal(contactRow.rankingScore, report.contactsCreated[0]!.rankingScore);
  assert.ok(contactRow.rankingReasons.length > 0);
  assert.ok(contactRow.rankedAt);
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

  // F7.8: un dominio de email ajeno fuerza REJECTED en el ranking -- el
  // Contact se sigue creando (el nombre real SÍ existe, es evidencia
  // honesta), pero queda marcado como no confiable para cualquier uso
  // comercial futuro (F7.9+), nunca oculto ni descartado silenciosamente.
  assert.equal(report.contactsCreated[0]!.rankingTier, "REJECTED");
  assert.equal(report.contactsCreated[0]!.rankingScore, 0);
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

// ---------- F15: cascada PDL -> Website Intelligence -> Hunter.io ----------
// "People Data Labs será solo una fuente de información" -- un 402/sin
// resultados de PDL nunca más termina la búsqueda de contactos: sigue
// automáticamente hacia Website Intelligence (namedPeople ya crawleado)
// y después Hunter.io, en ese orden, cada uno solo si el anterior no
// cubrió todos los roles planificados.

function namedPersonFixture(overrides: Partial<WebsiteNamedPerson> = {}): WebsiteNamedPerson {
  return {
    firstName: "Carlos",
    lastName: "Ramirez",
    title: "HR Manager",
    email: "carlos.ramirez@acme-mfg.com",
    sourceUrl: "https://acme-mfg.com/about-us/team",
    ...overrides,
  };
}

function hunterCandidateFixture(overrides: Partial<EmailCandidate> = {}): EmailCandidate {
  return {
    firstName: "Priya",
    lastName: "Singh",
    title: "HR Manager",
    email: "priya.singh@acme-mfg.com",
    confidenceScore: 0.9,
    sourceUrl: "https://acme-mfg.com/contact",
    ...overrides,
  };
}

function fakeHunterProvider(overrides: Partial<HunterContactProviderPort> = {}): HunterContactProviderPort {
  return {
    searchHunterEmails: async () => emptyEmailResult(),
    ...overrides,
  };
}

test("F15: PDL sin resultados (402/vacío) -> Website Intelligence encuentra la persona real, Contact creado con source correcto", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-pdl-to-website");
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
      contactProvider: fakeProvider({
        searchPeopleDataLabs: async () => ({ candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: ["HTTP 402: no credits"], cancelled: false, providerStatus: "CREDIT_EXHAUSTED" }),
      }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [namedPersonFixture()],
      hunterApiKey: "",
    }),
  );
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.source, "Website Intelligence");
  assert.equal(report.contactsCreated[0]!.firstName, "Carlos");
  assert.deepEqual(report.rolesWithoutContact, []);
  assert.ok(report.sourcesUsed.includes("Website Intelligence"));
  const contactRow = await prisma.contact.findUniqueOrThrow({ where: { id: report.contactsCreated[0]!.contactId } });
  assert.equal(contactRow.source, "Website Intelligence");
});

test("F15: PDL y Website sin resultados -> Hunter.io encuentra la persona real, Contact creado con source correcto", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-pdl-website-to-hunter");
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
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => emptyContactResult() }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [], // sin website o sin nadie encontrado ahí
      hunterProvider: fakeHunterProvider({
        searchHunterEmails: async () => ({
          candidates: [hunterCandidateFixture()],
          costUsd: 0,
          sourcesUsed: ["Hunter.io (test)"],
          patternsFailed: [],
          cancelled: false,
          providerStatus: "AVAILABLE",
        }),
      }),
      hunterApiKey: "fake-hunter-key-for-tests",
    }),
  );
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.source, "Hunter.io");
  assert.equal(report.contactsCreated[0]!.firstName, "Priya");
  assert.deepEqual(report.rolesWithoutContact, []);
  assert.ok(report.sourcesUsed.includes("Hunter.io"));
});

test("F15: ninguna de las 3 fuentes encuentra una persona real -> sin Contact, rolesWithoutContact honesto (candidato para 'organizacional')", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-all-empty");
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
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => emptyContactResult() }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [],
      hunterProvider: fakeHunterProvider({ searchHunterEmails: async () => emptyEmailResult() }),
      hunterApiKey: "fake-hunter-key-for-tests",
    }),
  );
  assert.equal(report.contactsCreated.length, 0);
  assert.deepEqual(report.rolesWithoutContact, ["HR Manager"]);
  const contacts = await prisma.contact.count({ where: { companyId } });
  assert.equal(contacts, 0);
});

test("F15: un candidato de Website con cargo irrelevante (roleMismatchSkipped) nunca crea un Contact -- la cascada sigue hacia Hunter", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-website-role-mismatch");
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
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => emptyContactResult() }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      // Nombre real, pero un cargo que no matchea ningún rol planificado
      // (rolePlanFixture solo pide "HR Manager") -- WebsiteNamedPerson
      // siempre trae nombre+apellido reales (la extracción lo exige, ver
      // extract.ts), así que "sin apellido" nunca es un caso real para
      // esta fuente -- el descarte real acá es por rol irrelevante.
      websiteNamedPeople: [namedPersonFixture({ title: "Accounts Receivable Associate" })],
      hunterProvider: fakeHunterProvider({
        searchHunterEmails: async () => ({
          candidates: [hunterCandidateFixture()],
          costUsd: 0,
          sourcesUsed: ["Hunter.io (test)"],
          patternsFailed: [],
          cancelled: false,
          providerStatus: "AVAILABLE",
        }),
      }),
      hunterApiKey: "fake-hunter-key-for-tests",
    }),
  );
  assert.equal(report.roleMismatchSkipped, 1);
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.source, "Hunter.io");
});

test("F15: si PDL ya cubrió el único rol planificado, Website y Hunter nunca se consultan (costo real evitado)", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-pdl-covers-all");
  let hunterCalled = false;
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
      contactProvider: fakeProvider({
        searchPeopleDataLabs: async () => ({ candidates: [candidateFixture()], costUsd: 0.05, sourcesUsed: ["People Data Labs (test)"], patternsFailed: [], cancelled: false, providerStatus: "AVAILABLE" }),
      }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      // Website igual trae una persona real -- nunca debe procesarse
      // porque PDL ya cubrió el único rol planificado (remainingRoles()
      // queda vacío antes de llegar a esta fuente).
      websiteNamedPeople: [namedPersonFixture({ firstName: "Nunca", lastName: "Debería Aparecer" })],
      hunterProvider: fakeHunterProvider({ searchHunterEmails: async () => { hunterCalled = true; return emptyEmailResult(); } }),
      hunterApiKey: "fake-hunter-key-for-tests",
    }),
  );
  assert.equal(report.contactsCreated.length, 1);
  assert.equal(report.contactsCreated[0]!.source, "People Data Labs");
  assert.equal(hunterCalled, false, "Hunter nunca debe llamarse si PDL ya cubrió todos los roles");
  const fakeNamedContact = await prisma.contact.findFirst({ where: { companyId, firstName: "Nunca" } });
  assert.equal(fakeNamedContact, null);
});

test("F15: cancelación durante PDL detiene la cascada de inmediato -- Website y Hunter nunca se consultan", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-cancelled-during-pdl");
  let hunterCalled = false;
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
      contactProvider: fakeProvider({
        searchPeopleDataLabs: async () => ({ candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: ["cancelled by user"], cancelled: true, providerStatus: "AVAILABLE" }),
      }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [namedPersonFixture()],
      hunterProvider: fakeHunterProvider({ searchHunterEmails: async () => { hunterCalled = true; return emptyEmailResult(); } }),
      hunterApiKey: "fake-hunter-key-for-tests",
    }),
  );
  assert.equal(report.cancelled, true);
  assert.equal(report.contactsCreated.length, 0);
  assert.equal(hunterCalled, false);
  const contacts = await prisma.contact.count({ where: { companyId } });
  assert.equal(contacts, 0);
});

test("F15: un contacto de Website que ya existe en el CRM (mismo nombre+empresa) se deduplica, nunca se crea dos veces", async () => {
  const { tenantId, companyId } = await setupTenantWithCompany("cascade-website-dedup");
  const report1 = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    enrichCompanyWithDecisionContacts({
      taskId: "test-task-1",
      companyId,
      companyName: "Acme Manufacturing",
      companyWebsite: "https://acme-mfg.com",
      companyState: "IL",
      companyCity: "Chicago",
      industryName: "Manufacturing",
      rolePlan: rolePlanFixture(companyId),
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => emptyContactResult() }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [namedPersonFixture()],
      hunterApiKey: "",
    }),
  );
  assert.equal(report1.contactsCreated.length, 1);

  const report2 = await runWithTenancyContext({ tenantId, userId: `${TEST_PREFIX}-user`, permissions: [] }, () =>
    enrichCompanyWithDecisionContacts({
      taskId: "test-task-2",
      companyId,
      companyName: "Acme Manufacturing",
      companyWebsite: "https://acme-mfg.com",
      companyState: "IL",
      companyCity: "Chicago",
      industryName: "Manufacturing",
      rolePlan: rolePlanFixture(companyId),
      contactProvider: fakeProvider({ searchPeopleDataLabs: async () => emptyContactResult() }),
      peopleDataLabsApiKey: "fake-key-for-tests",
      websiteNamedPeople: [namedPersonFixture()],
      hunterApiKey: "",
    }),
  );
  assert.equal(report2.contactsCreated.length, 0);
  assert.equal(report2.duplicatesSkipped, 1);
  const contacts = await prisma.contact.count({ where: { companyId } });
  assert.equal(contacts, 1);
});
