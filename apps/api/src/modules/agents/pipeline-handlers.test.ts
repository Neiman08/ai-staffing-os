import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { buildEventEnvelope } from "@ai-staffing-os/agents";
import type { PipelineFlags } from "../../core/pipeline-flags";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { publishEvent } from "../../core/events/outbox";
import { EventDispatcher } from "../../core/events/dispatcher";
import { registerPipelineHandlers } from "./pipeline-handlers";
import { resolveHumanReviewRequest } from "../human-review/service";
import { recordTaskFailure } from "./task-lifecycle";
import { pausePilotMission, cancelPilotMission } from "./pilot-mission-control";

/**
 * F25.2 (activación controlada, Prioridad 3): pruebas de integración
 * contra Postgres real de los 3 handlers reales -- multi-tenant,
 * idempotentes, gateados por flag.
 */

const TEST_PREFIX = "F25-2-PIPELINE-HANDLERS";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.humanReviewRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

function allFlagsOff(): PipelineFlags {
  return {
    autonomousWorkerEnabled: false,
    missionTaskProductionEnabled: false,
    discoveryAgentEnabled: false,
    contactIntelligenceAgentEnabled: false,
    qualityAgentEnabled: false,
    eventHandlersEnabled: false,
    draftAgentEnabled: false,
    externalActionsEnabled: false,
    autonomousSendingEnabled: false,
  };
}

async function setupTenant(suffix: string): Promise<{ tenantId: string; agentInstanceId: string; industryId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  const contactIntelDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "contact_intelligence" } });
  const contactIntelInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: contactIntelDefinition.id, isActive: true } });
  const qualityDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "quality" } });
  await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: qualityDefinition.id, isActive: true } });
  const salesDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "sales" } });
  await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: salesDefinition.id, isActive: true } });
  const industry = await prisma.industry.findFirstOrThrow();
  return { tenantId: tenant.id, agentInstanceId: contactIntelInstance.id, industryId: industry.id };
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "system-test", permissions: [] }, fn);
}

test("company.discovered.v1: sin contactIntelligenceAgentEnabled, no crea ninguna tarea", async () => {
  const { tenantId, industryId } = await setupTenant("company-discovered-off");
  const company = await prisma.company.create({
    data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER", discoveryMetadata: { queryOrigins: ["electrical"] } },
  });

  const { event } = await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "company.discovered.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "company",
        entityId: company.id,
        payload: { companyId: company.id },
        idempotencyKey: `test-company-discovered-${company.id}`,
      }),
    ),
  );

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, allFlagsOff());
  await dispatcher.runOnce();

  const tasks = await prisma.agentTask.findMany({ where: { tenantId, type: "find_contacts" } });
  assert.equal(tasks.length, 0);
  void event;
});

test("company.discovered.v1: con el flag prendido, crea find_contacts real con rolePlan construido desde la taxonomía real", async () => {
  const { tenantId, industryId } = await setupTenant("company-discovered-on");
  const company = await prisma.company.create({
    data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER", discoveryMetadata: { queryOrigins: ["electrical"] } },
  });

  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "company.discovered.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "company",
        entityId: company.id,
        payload: { companyId: company.id },
        idempotencyKey: `test-company-discovered-on-${company.id}`,
      }),
    ),
  );

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, { ...allFlagsOff(), contactIntelligenceAgentEnabled: true });
  const metrics = await dispatcher.runOnce();

  assert.equal(metrics.failed, 0);
  const task = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "find_contacts" } });
  assert.equal(task.status, "QUEUED");
  assert.equal(task.triggeredBy, "EVENT");
  assert.equal(task.correlationId, "mission_test");
  const input = task.input as { companyId: string; taskId: string; rolePlan: { targetRoles: unknown[] } };
  assert.equal(input.companyId, company.id);
  assert.equal(input.taskId, task.id);
  assert.ok(input.rolePlan.targetRoles.length > 0, "el rolePlan debe tener roles reales de la taxonomía 'electrical'");
});

test("company.discovered.v1: idempotente -- procesar el mismo evento dos veces nunca crea una segunda tarea", async () => {
  const { tenantId, industryId } = await setupTenant("company-discovered-idempotent");
  const company = await prisma.company.create({
    data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER", discoveryMetadata: { queryOrigins: ["electrical"] } },
  });

  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "company.discovered.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "company",
        entityId: company.id,
        payload: { companyId: company.id },
        idempotencyKey: `test-company-discovered-idem-${company.id}`,
      }),
    ),
  );

  const flags = { ...allFlagsOff(), contactIntelligenceAgentEnabled: true };
  const dispatcher1 = new EventDispatcher();
  registerPipelineHandlers(dispatcher1, flags);
  await dispatcher1.runOnce();

  // Simula un replay real: el mismo companyId, mismo correlationId,
  // llamando al handler una segunda vez directamente (el escenario que
  // el índice único de idempotencyKey debe blindar).
  const dispatcher2 = new EventDispatcher();
  registerPipelineHandlers(dispatcher2, flags);
  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "company.discovered.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "company",
        entityId: company.id,
        payload: { companyId: company.id },
        idempotencyKey: `test-company-discovered-idem2-${company.id}`,
      }),
    ),
  );
  await dispatcher2.runOnce();

  const tasks = await prisma.agentTask.findMany({ where: { tenantId, type: "find_contacts" } });
  assert.equal(tasks.length, 1, "el índice único de idempotencyKey garantiza una sola tarea, no una convención de aplicación");
});

// ---------- F26 (primer piloto de outreach real): contact.verified.v1 -> draft_outreach ----------

test("contact.verified.v1: sin draftAgentEnabled, no crea ninguna tarea", async () => {
  const { tenantId, industryId } = await setupTenant("contact-verified-off");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER" } });

  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "contact.verified.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "contact",
        entityId: "contact_test",
        payload: { contactId: "contact_test", companyId: company.id, emailVerificationStatus: "VERIFIED" },
        idempotencyKey: `test-contact-verified-off-${company.id}`,
      }),
    ),
  );

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, allFlagsOff());
  await dispatcher.runOnce();

  assert.equal(await prisma.agentTask.count({ where: { tenantId, type: "draft_outreach" } }), 0);
});

test("contact.verified.v1: con draftAgentEnabled, crea draft_outreach real con companyId del payload", async () => {
  const { tenantId, industryId } = await setupTenant("contact-verified-on");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER" } });

  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "contact.verified.v1",
        tenantId,
        correlationId: "mission_test",
        causationId: null,
        actorType: "AGENT",
        actorId: "agentinstance_test",
        entityType: "contact",
        entityId: "contact_test",
        payload: { contactId: "contact_test", companyId: company.id, emailVerificationStatus: "VERIFIED" },
        idempotencyKey: `test-contact-verified-on-${company.id}`,
      }),
    ),
  );

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, { ...allFlagsOff(), draftAgentEnabled: true });
  const metrics = await dispatcher.runOnce();

  assert.equal(metrics.failed, 0);
  const task = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "draft_outreach" } });
  assert.equal(task.status, "QUEUED");
  assert.equal(task.triggeredBy, "EVENT");
  assert.equal(task.correlationId, "mission_test");
  const input = task.input as { companyId: string };
  assert.equal(input.companyId, company.id);
});

test("contact.verified.v1: idempotente -- dos contactos verificados de la MISMA Company solo crean una draft_outreach", async () => {
  const { tenantId, industryId } = await setupTenant("contact-verified-idempotent");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER" } });

  const flags = { ...allFlagsOff(), draftAgentEnabled: true };
  for (const contactId of ["contact_a", "contact_b"]) {
    await withTenant(tenantId, () =>
      publishEvent(
        buildEventEnvelope({
          eventType: "contact.verified.v1",
          tenantId,
          correlationId: "mission_test",
          causationId: null,
          actorType: "AGENT",
          actorId: "agentinstance_test",
          entityType: "contact",
          entityId: contactId,
          payload: { contactId, companyId: company.id, emailVerificationStatus: "VERIFIED" },
          idempotencyKey: `test-contact-verified-idem-${contactId}`,
        }),
      ),
    );
    const dispatcher = new EventDispatcher();
    registerPipelineHandlers(dispatcher, flags);
    await dispatcher.runOnce();
  }

  assert.equal(await prisma.agentTask.count({ where: { tenantId, type: "draft_outreach" } }), 1, "un solo draft_outreach por Company, sin importar cuántos contactos se verifiquen");
});

test("outreach.draft_created.v1: con qualityAgentEnabled, crea evaluate_draft_quality con los datos reales de la ApprovalRequest", async () => {
  const { tenantId, industryId } = await setupTenant("draft-created");
  const company = await prisma.company.create({
    data: { tenantId, name: "Acme Electrical", industryId, status: "LEAD", origin: "API_PROVIDER", commercialStatus: "COMMERCIAL_VALIDATED" },
  });
  const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId, definition: { key: "contact_intelligence" } } });
  const task = await prisma.agentTask.create({
    data: { tenantId, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
  });
  const approval = await prisma.approvalRequest.create({
    data: {
      tenantId,
      agentTaskId: task.id,
      companyId: company.id,
      summary: "Borrador de prueba",
      proposedAction: { to: "contact@acme.example", subject: "Asunto", body: "Cuerpo real, sin placeholders." },
      riskLevel: "MEDIUM",
    },
  });

  await withTenant(tenantId, () =>
    publishEvent(
      buildEventEnvelope({
        eventType: "outreach.draft_created.v1",
        tenantId,
        correlationId: "mission_draft_test",
        causationId: null,
        actorType: "AGENT",
        actorId: agentInstance.id,
        entityType: "approval_request",
        entityId: approval.id,
        payload: { approvalRequestId: approval.id, companyId: company.id, channel: "EMAIL", subjectPreview: "Asunto" },
        idempotencyKey: `test-draft-created-${approval.id}`,
      }),
    ),
  );

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher, { ...allFlagsOff(), qualityAgentEnabled: true });
  const metrics = await dispatcher.runOnce();

  assert.equal(metrics.failed, 0);
  const qualityTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId, type: "evaluate_draft_quality" } });
  const input = qualityTask.input as { approvalRequestId: string; to: string; companyCommercialStatus: string };
  assert.equal(input.approvalRequestId, approval.id);
  assert.equal(input.to, "contact@acme.example");
  assert.equal(input.companyCommercialStatus, "COMMERCIAL_VALIDATED");
});

test("company.discovered.v1: una misión piloto pausada/cancelada nunca crea una find_contacts nueva (Prioridad 8)", async () => {
  const { tenantId, industryId, agentInstanceId } = await setupTenant("company-discovered-paused");

  async function missionCompanyDiscoveredSkips(controlAction: "pause" | "cancel") {
    const company = await prisma.company.create({
      data: { tenantId, name: `Acme ${controlAction}`, industryId, status: "LEAD", origin: "API_PROVIDER", discoveryMetadata: { queryOrigins: ["electrical"] } },
    });
    const correlationId = `mission_control_${controlAction}_${company.id}`;
    const rootTask = await prisma.agentTask.create({
      data: { tenantId, agentInstanceId, type: "discover_companies", status: "DONE", input: {}, triggeredBy: "USER", correlationId, idempotencyKey: `idem_${correlationId}` },
    });

    await withTenant(tenantId, () => (controlAction === "pause" ? pausePilotMission(rootTask.id) : cancelPilotMission(rootTask.id)));

    await withTenant(tenantId, () =>
      publishEvent(
        buildEventEnvelope({
          eventType: "company.discovered.v1",
          tenantId,
          correlationId,
          causationId: null,
          actorType: "AGENT",
          actorId: "agentinstance_test",
          entityType: "company",
          entityId: company.id,
          payload: { companyId: company.id },
          idempotencyKey: `test-company-discovered-${controlAction}-${company.id}`,
        }),
      ),
    );

    const dispatcher = new EventDispatcher();
    registerPipelineHandlers(dispatcher, { ...allFlagsOff(), contactIntelligenceAgentEnabled: true });
    const metrics = await dispatcher.runOnce();
    assert.equal(metrics.failed, 0);

    const tasks = await prisma.agentTask.findMany({ where: { tenantId, type: "find_contacts", correlationId } });
    assert.equal(tasks.length, 0, `una misión ${controlAction === "pause" ? "pausada" : "cancelada"} no debe crear find_contacts`);
  }

  await missionCompanyDiscoveredSkips("pause");
  await missionCompanyDiscoveredSkips("cancel");
});

test("human.review_resolved.v1: reanuda una AgentTask real en HUMAN_REVIEW cuando entityType=agent_task", async () => {
  const { tenantId } = await setupTenant("human-review-resume");
  const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId, definition: { key: "contact_intelligence" } } });
  const task = await prisma.agentTask.create({
    data: { tenantId, agentInstanceId: agentInstance.id, type: "find_contacts", status: "QUEUED", input: {}, triggeredBy: "AGENT", correlationId: "mission_hr_resume" },
  });

  await withTenant(tenantId, async () => {
    const { AgentError } = await import("@ai-staffing-os/agents");
    await recordTaskFailure(task.id, new AgentError("HUMAN_ACTION_REQUIRED", "Ambiguo, requiere decisión humana"));
  });

  const midway = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(midway.status, "HUMAN_REVIEW");

  await withTenant(tenantId, async () => {
    const { request } = await import("../human-review/service").then((m) =>
      m.createOrMergeHumanReviewRequest({
        type: "SYSTEM_FAILURE",
        priority: "HIGH",
        entityType: "agent_task",
        entityId: task.id,
        summary: "test",
        evidence: [],
        requestedDecision: "test",
        options: [],
        recommendation: null,
        impact: "test",
        correlationId: "mission_hr_resume",
      }),
    );
    await resolveHumanReviewRequest(request.id, "user-1", "Continuar con el contacto genérico");
  });

  const dispatcher = new EventDispatcher();
  registerPipelineHandlers(dispatcher);
  await dispatcher.runOnce();

  const resumed = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(resumed.status, "DONE");
  assert.deepEqual(resumed.output, { humanResolution: "Continuar con el contacto genérico" });
});
