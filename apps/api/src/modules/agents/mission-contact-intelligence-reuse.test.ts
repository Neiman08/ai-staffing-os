import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { runMissionPipeline } from "./mission-orchestrator";

/**
 * F30 (hallazgo real, auditoría de degradación elegante, MIS-20260730-0001,
 * 2026-07-30): con Google Places sin presupuesto, el fallback amplio de
 * select_target_companies siguió funcionando (25 empresas reutilizadas
 * del CRM, Lead+Opportunity+Draft reales) -- pero el loop por-compañía
 * (mission-orchestrator.ts) iba directo de la selección a score_company/
 * create_lead, sin intentar NUNCA Contact Intelligence (Hunter/PDL/
 * Website Intelligence) para las Companies reutilizadas que llegaban sin
 * ningún punto de contacto real (20 de 25 en esa misión real). Esos
 * proveedores son completamente independientes del presupuesto de
 * descubrimiento de empresas (Google Places) -- bloquear uno nunca
 * debería bloquear el otro.
 *
 * Este test ejercita el pipeline clásico estático de punta a punta
 * (runMissionPipeline real) con Companies YA existentes -- mismo patrón
 * que mission-require-hiring-signal.test.ts/mission-name-exclusion.test.ts
 * (instrucción sin ningún término de taxonomía real, industryNames
 * pasado directo, cero descubrimiento externo real) -- y confirma que
 * find_contacts/find_email (Contact Intelligence Agent, F4.6/F4.7) se
 * disparan de verdad para una Company reutilizada sin contacto, y NUNCA
 * para una que ya tiene uno (nunca un segundo intento redundante).
 *
 * find_contacts/find_email llaman a PDL/Hunter reales (sin inyección de
 * proveedor fake disponible a este nivel, ver contact-intelligence-tools.impl.ts)
 * -- se usa un nombre de empresa sintético que no matchea a nadie real en
 * PDL (costo real esperado: $0, PDL cobra por match encontrado, no por
 * intento) y sin website (Website Intelligence ni siquiera intenta un
 * fetch real).
 */

const TEST_PREFIX = "F30-CONTACT-REUSE";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.followUp.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.opportunity.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);

  const ceoDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "ceo" } });
  const ceoInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: ceoDefinition.id, isActive: true } });
  for (const key of ["campaign", "sales", "outreach", "contact_intelligence"]) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }
  return { tenant, ceoInstance };
}

function missionRestrictions() {
  return {
    allowOutreach: false,
    allowDraftCreation: false,
    allowMessageSending: false,
    allowCampaignCreation: true,
    allowOpportunityCreation: true,
    requireHiringSignal: true,
  };
}

async function createMissionTask(tenantId: string, ceoInstanceId: string) {
  const rawInstruction = "Procesa las empresas existentes que estén contratando.";
  const restrictions = missionRestrictions();
  return prisma.agentTask.create({
    data: {
      tenantId,
      agentInstanceId: ceoInstanceId,
      type: "daily_revenue_mission",
      status: "RUNNING",
      triggeredBy: "USER",
      input: {
        rawInstruction,
        launchedByUserId: "test-user",
        industryNames: ["Manufacturing"],
        state: "IL",
        city: null,
        categoryNames: [],
        desiredVolume: null,
        businessObjective: { type: "companies_found", target: null, unit: "empresas", rawText: rawInstruction },
        unrecognizedTerms: [],
        useExternalDiscovery: false,
        externalSearchTerms: [],
        missionRestrictions: restrictions,
      },
      output: {
        missionState: "RUNNING",
        companiesTargeted: 0,
        leadsCreated: 0,
        opportunitiesCreated: 0,
        sequencesPlanned: 0,
        draftsAwaitingApproval: 0,
        costUsdSoFar: 0,
        objectiveProgress: { type: "companies_found", target: null, unit: "empresas", current: 0, percentComplete: null, rawText: rawInstruction },
        progressUpdatedAt: new Date().toISOString(),
        error: null,
        appliedRestrictions: restrictions,
        restrictionNotes: [],
      },
    },
  });
}

test("runMissionPipeline: Company reutilizada del CRM SIN ningún punto de contacto -> dispara find_contacts + find_email de verdad", async () => {
  const { tenant, ceoInstance } = await setupTenant("no-contact");
  const manufacturing = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing", isGlobal: true } });

  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: `F30 Synthetic Fixture Co ${Date.now()}`,
      industryId: manufacturing.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      email: null,
      website: null,
      discoveryMetadata: { hiringSignal: { hiringStatus: "CONFIRMED_HIRING" } },
    },
  });

  const task = await createMissionTask(tenant.id, ceoInstance.id);
  await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () =>
    runMissionPipeline(task.id, tenant.id, "test-user"),
  );

  const children = await prisma.agentTask.findMany({ where: { parentTaskId: task.id } });
  const findContactsTask = children.find((t) => t.type === "find_contacts" && (t.input as { companyId?: string })?.companyId === company.id);
  const findEmailTask = children.find((t) => t.type === "find_email" && (t.input as { companyId?: string })?.companyId === company.id);

  assert.ok(findContactsTask, "una Company reutilizada sin contacto debía disparar find_contacts real");
  assert.notEqual(findContactsTask!.status, "FAILED", "find_contacts no debía fallar -- sin proveedor configurado o sin matches es un resultado válido, nunca un error");
  assert.ok(findEmailTask, "una Company reutilizada sin contacto debía disparar find_email real");
  assert.notEqual(findEmailTask!.status, "FAILED");
});

test("runMissionPipeline: Company reutilizada CON email ya existente -> nunca dispara find_contacts/find_email (ya tiene punto de contacto real)", async () => {
  const { tenant, ceoInstance } = await setupTenant("has-contact");
  const manufacturing = await prisma.industry.findFirstOrThrow({ where: { name: "Manufacturing", isGlobal: true } });

  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: `F30 Already Has Email Co ${Date.now()}`,
      industryId: manufacturing.id,
      state: "IL",
      origin: "API_PROVIDER",
      commercialStatus: "COMMERCIAL_VALIDATED",
      email: "info@f30-already-has-email.example",
      discoveryMetadata: { hiringSignal: { hiringStatus: "CONFIRMED_HIRING" } },
    },
  });

  const task = await createMissionTask(tenant.id, ceoInstance.id);
  await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, () =>
    runMissionPipeline(task.id, tenant.id, "test-user"),
  );

  const children = await prisma.agentTask.findMany({ where: { parentTaskId: task.id } });
  const findContactsTask = children.find((t) => t.type === "find_contacts" && (t.input as { companyId?: string })?.companyId === company.id);
  const findEmailTask = children.find((t) => t.type === "find_email" && (t.input as { companyId?: string })?.companyId === company.id);

  assert.equal(findContactsTask, undefined, "una Company que ya tiene email real nunca debía disparar find_contacts -- sería un intento redundante");
  assert.equal(findEmailTask, undefined, "mismo criterio para find_email");

  // Control positivo: el resto del pipeline comercial igual avanzó con normalidad.
  const lead = await prisma.lead.findFirst({ where: { companyId: company.id } });
  assert.ok(lead, "el pipeline comercial debía seguir avanzando con normalidad para esta Company");
});
