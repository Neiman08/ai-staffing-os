import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_POLICY_ENVELOPE, type LLMProvider } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { createDraftExecutor, type DraftTaskInput } from "./draft.executor";
import { fakeDraftLLMProvider } from "../draft-generation.test-support";

/**
 * F26 (primer piloto de outreach real): Draft real, un solo disparo.
 * Reusa (sin duplicar) evaluateDraftCreationGate/resolveBestContactChannel
 * -- la batería completa de los 4 bloqueos ya vive en
 * draft-creation-gate.test.ts; acá se prueba que ESTE executor los
 * respeta de verdad (nunca gasta el LLM cuando el gate bloquea) y que el
 * camino feliz crea Lead+ApprovalRequest+evento reales.
 */

const TEST_PREFIX = "F26-DRAFT-EXEC";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<{ tenantId: string; industryId: string }> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.create({ data: { tenantId: tenant.id, name: "Construction", isGlobal: false } });
  return { tenantId: tenant.id, industryId: industry.id };
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, fn);
}

// ApprovalRequest.agentTaskId es una FK real -- un taskId inventado
// revienta con P2003 en cualquier test que llegue a crear el
// ApprovalRequest. Se crea una AgentTask real por tenant y se reusa.
async function realTaskId(tenantId: string): Promise<string> {
  const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "sales" } });
  const agentInstance = await prisma.agentInstance.create({ data: { tenantId, definitionId: definition.id, isActive: true } });
  const task = await prisma.agentTask.create({ data: { tenantId, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "RUNNING", input: {}, triggeredBy: "AGENT" } });
  return task.id;
}

function fakeContext(tenantId: string, taskId = "task_test") {
  return {
    tenantId,
    agentInstanceId: "agentinstance_test",
    taskId,
    triggeredBy: "AGENT" as const,
    correlationId: "mission_test",
    causationId: "cause_test",
    capabilities: [],
    policyEnvelope: DEFAULT_POLICY_ENVELOPE,
  };
}

const fakeLLMProvider = fakeDraftLLMProvider;

test("execute() con Company DEMO_SEED: gate bloquea, agentSuccess con blockReason DEMO_SEED, nunca llama al LLM", async () => {
  const { tenantId, industryId } = await setupTenant("demo-seed");
  const company = await prisma.company.create({ data: { tenantId, name: "Demo Co", industryId, status: "LEAD", origin: "DEMO_SEED", email: "demo@example.com" } });
  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);
  const input: DraftTaskInput = { companyId: company.id };

  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), input));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.approvalRequestId, null);
  assert.equal(result.output.blockReason, "DEMO_SEED");
  assert.equal(callCount(), 0, "nunca se gasta el LLM cuando el gate bloquea");
  assert.equal(await prisma.approvalRequest.count({ where: { tenantId } }), 0);
});

test("execute() sin canal de contacto EMAIL-capable: blockReason NEEDS_ENRICHMENT, persiste Company.outreachBlockedReason", async () => {
  const { tenantId, industryId } = await setupTenant("no-channel");
  const company = await prisma.company.create({ data: { tenantId, name: "Sin Canal Co", industryId, status: "LEAD", origin: "API_PROVIDER" } });
  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);

  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.blockReason, "NEEDS_ENRICHMENT");
  assert.equal(callCount(), 0);

  const stored = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(stored.outreachBlockedReason, "NEEDS_ENRICHMENT");
});

test("execute() con isClientOwnerCandidate=true: blockReason CLIENT_OWNER_REVIEW, nunca redacta outreach para un posible cliente actual", async () => {
  const { tenantId, industryId } = await setupTenant("client-owner");
  const company = await prisma.company.create({
    data: { tenantId, name: "QTS Co", industryId, status: "LEAD", origin: "API_PROVIDER", email: "info@qts.example", discoveryMetadata: { isClientOwnerCandidate: true } },
  });
  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);

  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.blockReason, "CLIENT_OWNER_REVIEW");
  assert.equal(callCount(), 0);
});

test("execute() con discoveryMetadata.opportunityRecommendation=MANUAL_REVIEW (snapshot de Discovery, pre-enriquecimiento): nunca bloquea -- ese snapshot es previo a Contact Intelligence", async () => {
  const { tenantId, industryId } = await setupTenant("stale-recommendation");
  const company = await prisma.company.create({
    data: {
      tenantId,
      name: "Fresh Co",
      industryId,
      status: "LEAD",
      origin: "API_PROVIDER",
      // F26: esto es EXACTAMENTE lo que mission-executor.ts persiste
      // durante Discovery, antes de que exista ningún Contact real en el
      // pipeline piloto (find_contacts corre después, reactivo) -- casi
      // siempre MANUAL_REVIEW por evidencia insuficiente en ese momento.
      discoveryMetadata: { isClientOwnerCandidate: false, opportunityRecommendation: { recommendation: "MANUAL_REVIEW" } },
    },
  });
  await prisma.contact.create({
    data: { tenantId, companyId: company.id, firstName: "Jane", lastName: "Doe", email: "jane@fresh-co.example", emailVerificationStatus: "VERIFIED", isPrimary: true },
  });

  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);
  const taskId = await withTenant(tenantId, () => realTaskId(tenantId));
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId, taskId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.blockReason, null, "el snapshot viejo de opportunityRecommendation nunca debe bloquear un contacto ya verificado");
  assert.ok(result.output.approvalRequestId);
  assert.equal(callCount(), 1);
});

test("execute() con un ApprovalRequest activo ya existente para la Company: blockReason DUPLICATE_ACTIVE", async () => {
  const { tenantId, industryId } = await setupTenant("duplicate");
  const company = await prisma.company.create({ data: { tenantId, name: "Duplicate Co", industryId, status: "LEAD", origin: "API_PROVIDER", email: "info@dup.example" } });
  const agentInstance = await prisma.agentInstance.create({
    data: { tenantId, definitionId: (await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "sales" } })).id, isActive: true },
  });
  const existingTask = await prisma.agentTask.create({ data: { tenantId, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" } });
  await prisma.approvalRequest.create({
    data: { tenantId, agentTaskId: existingTask.id, companyId: company.id, summary: "ya existe", proposedAction: { channel: "EMAIL", to: "info@dup.example" }, riskLevel: "MEDIUM", status: "PENDING" },
  });

  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.blockReason, "DUPLICATE_ACTIVE");
  assert.equal(callCount(), 0);
});

test("execute() nunca elige un Contact con doNotContact/bouncedAt/unsubscribedAt -- cae al email de Company si lo hay", async () => {
  const { tenantId, industryId } = await setupTenant("do-not-contact");
  const company = await prisma.company.create({ data: { tenantId, name: "DNC Co", industryId, status: "LEAD", origin: "API_PROVIDER", email: "org@dnc.example" } });
  await prisma.contact.create({
    data: { tenantId, companyId: company.id, firstName: "Opted", lastName: "Out", email: "opted.out@dnc.example", emailVerificationStatus: "VERIFIED", doNotContact: true, isPrimary: true },
  });

  const { provider } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);
  const taskId = await withTenant(tenantId, () => realTaskId(tenantId));
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId, taskId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.ok(result.output.approvalRequestId, "debe poder redactar igual usando el email de la Company");

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: result.output.approvalRequestId! } });
  const proposedAction = approval.proposedAction as { to: string; contactId: string | null };
  assert.equal(proposedAction.to, "org@dnc.example", "nunca usa el email del contacto opted-out, aunque esté VERIFIED");
  assert.equal(proposedAction.contactId, null);
});

test("execute() camino feliz: crea Lead + ApprovalRequest real + publica outreach.draft_created.v1 con el correlationId de la misión", async () => {
  const { tenantId, industryId } = await setupTenant("happy-path");
  const company = await prisma.company.create({ data: { tenantId, name: "Acme Electrical Real", industryId, status: "LEAD", origin: "API_PROVIDER", city: "Chicago", state: "IL" } });
  await prisma.contact.create({
    data: { tenantId, companyId: company.id, firstName: "Jane", lastName: "Doe", title: "Operations Manager", email: "jane.doe@acme-electrical-real.example", emailVerificationStatus: "VERIFIED", isPrimary: true },
  });

  const { provider, callCount } = fakeLLMProvider();
  const executor = createDraftExecutor(provider);
  const taskId = await withTenant(tenantId, () => realTaskId(tenantId));
  const context = fakeContext(tenantId, taskId);

  const result = await withTenant(tenantId, () => executor.execute(context, { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.blockReason, null);
  assert.ok(result.output.approvalRequestId);
  assert.equal(callCount(), 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.eventType, "outreach.draft_created.v1");
  assert.equal(result.events[0]!.correlationId, context.correlationId);
  assert.equal(result.events[0]!.causationId, context.causationId);

  const lead = await prisma.lead.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
  assert.equal(lead.status, "NEW");
  assert.equal(lead.source, "pilot-mission");

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: result.output.approvalRequestId! } });
  const proposedAction = approval.proposedAction as { to: string; leadId: string; contactId: string; subject: string; body: string; draftMetadata?: { recipientType?: string; recipientName?: string | null } };
  assert.equal(proposedAction.to, "jane.doe@acme-electrical-real.example");
  assert.equal(proposedAction.leadId, lead.id);
  assert.match(proposedAction.subject, /Acme Electrical Real/);
  assert.equal(proposedAction.draftMetadata?.recipientType, "person");
  assert.equal(proposedAction.draftMetadata?.recipientName, "Jane");
  assert.equal(approval.status, "PENDING", "nunca se auto-aprueba -- queda esperando decisión humana");
});

// Invariante #6 (endurecimiento del motor, hallazgo real MIS-20260802-0002):
// un fallo del proveedor de LLM (ej. OPENAI_API_KEY ausente) para UNA
// Company nunca debe ser un agentFailure duro -- generateOutreachDraft
// (draft-generation.ts) atrapa el error del proveedor, agota sus 2
// intentos, y devuelve {status:"skipped"} en vez de lanzar. El executor
// entonces termina en agentSuccess con un blockReason honesto, nunca crea
// nada a medias (ni Lead ni ApprovalRequest).
test("execute() sin OPENAI_API_KEY configurada (LLM falla): agentSuccess con blockReason honesto, nunca crea nada a medias", async () => {
  const { tenantId, industryId } = await setupTenant("no-api-key");
  const company = await prisma.company.create({ data: { tenantId, name: "Sin Key Co", industryId, status: "LEAD", origin: "API_PROVIDER" } });
  await prisma.contact.create({
    data: { tenantId, companyId: company.id, firstName: "Jane", lastName: "Doe", email: "jane@sinkey.example", emailVerificationStatus: "VERIFIED", isPrimary: true },
  });

  const failingProvider: LLMProvider = {
    complete: async () => {
      throw new Error("OPENAI_API_KEY no está configurada -- no se puede redactar un borrador real.");
    },
  };
  const executor = createDraftExecutor(failingProvider);
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), { companyId: company.id }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.approvalRequestId, null);
  assert.equal(result.output.blockReason, "DRAFT_GENERATION_INSUFFICIENT_EVIDENCE");
  assert.ok(result.output.draftSkippedReason?.includes("OPENAI_API_KEY"));
  assert.equal(await prisma.lead.count({ where: { tenantId } }), 0);
  assert.equal(await prisma.approvalRequest.count({ where: { tenantId } }), 0);
});
