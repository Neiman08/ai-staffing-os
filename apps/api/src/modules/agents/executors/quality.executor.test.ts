import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { DEFAULT_POLICY_ENVELOPE } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { evaluateDraftCreationGate } from "../../ceo-intelligence/draft-creation-gate";
import { evaluateApprovalQualityGate } from "../../ceo-intelligence/approval-quality-gate";
import { resolveBestContactChannel } from "../../ceo-intelligence/contact-channel";
import { findKnownPlaceholders } from "@ai-staffing-os/shared";
import { QUALITY_AGENT_CAPABILITIES, createQualityAgentExecutor, deriveQualityVerdict, type QualityTaskInput } from "./quality.executor";

/**
 * F25.2 Fase 8 + activación controlada (Prioridad 5): prueba (1) que
 * QUALITY_AGENT_CAPABILITIES reexpone las MISMAS referencias de función
 * de F24 -- prueba de identidad, no solo de comportamiento -- y (2) el
 * wrapper AgentExecutor sobre evaluateApprovalQualityGate, incluida la
 * taxonomía de 5 verdicts. La lógica de los 8 checks en sí ya tiene su
 * batería completa en approval-quality-gate.test.ts.
 */

const TEST_PREFIX = "F25-2-QUALITY-EXEC";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.humanReviewRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.domainEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

function fakeContext(tenantId: string) {
  return {
    tenantId,
    agentInstanceId: "agentinstance_test",
    taskId: "task_test",
    triggeredBy: "AGENT" as const,
    correlationId: "mission_test",
    causationId: null,
    capabilities: [],
    policyEnvelope: DEFAULT_POLICY_ENVELOPE,
  };
}

function baseInput(overrides: Partial<QualityTaskInput> = {}): QualityTaskInput {
  return {
    approvalRequestId: `approval_test_${Math.random().toString(36).slice(2, 10)}`,
    companyOrigin: "API_PROVIDER",
    companyCommercialStatus: "COMMERCIAL_VALIDATED",
    to: "contact@realcompany.example",
    subject: "Asunto real",
    body: "Cuerpo real, sin placeholders.",
    hasOtherActiveDuplicateApproval: false,
    ...overrides,
  };
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test", permissions: [] }, fn);
}

test("QUALITY_AGENT_CAPABILITIES reexpone las mismas 4 referencias de función de F24 -- nunca una copia", () => {
  assert.equal(QUALITY_AGENT_CAPABILITIES.evaluateDraftCreationGate, evaluateDraftCreationGate);
  assert.equal(QUALITY_AGENT_CAPABILITIES.evaluateApprovalQualityGate, evaluateApprovalQualityGate);
  assert.equal(QUALITY_AGENT_CAPABILITIES.resolveBestContactChannel, resolveBestContactChannel);
  assert.equal(QUALITY_AGENT_CAPABILITIES.findKnownPlaceholders, findKnownPlaceholders);
});

test("createQualityAgentExecutor declara taskType/stage consistentes con el catálogo real", () => {
  const executor = createQualityAgentExecutor();
  assert.equal(executor.taskType, "evaluate_draft_quality");
  assert.equal(executor.stage, "QUALITY_REVIEW");
});

test("deriveQualityVerdict: taxonomía completa de 5 verdicts, cada uno con su check real", () => {
  assert.equal(deriveQualityVerdict([]), "PASS");
  assert.equal(deriveQualityVerdict([{ check: "no_duplicates", reason: "r" }]), "HUMAN_REVIEW");
  assert.equal(deriveQualityVerdict([{ check: "company_valid", reason: "r" }]), "BLOCKED");
  assert.equal(deriveQualityVerdict([{ check: "classification_valid", reason: "r" }]), "BLOCKED");
  assert.equal(deriveQualityVerdict([{ check: "minimal_metadata", reason: "r" }]), "BLOCKED");
  assert.equal(deriveQualityVerdict([{ check: "contact_valid", reason: "r" }]), "NEEDS_ENRICHMENT");
  assert.equal(deriveQualityVerdict([{ check: "email_valid", reason: "r" }]), "NEEDS_ENRICHMENT");
  assert.equal(deriveQualityVerdict([{ check: "no_placeholders", reason: "r" }]), "NEEDS_REVISION");
  assert.equal(deriveQualityVerdict([{ check: "content_complete", reason: "r" }]), "NEEDS_REVISION");
});

test("execute() con un borrador válido: agentSuccess, publica outreach.quality_passed.v1 real con verdict=PASS", async () => {
  const tenantId = await setupTenant("pass");
  const executor = createQualityAgentExecutor();
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), baseInput()));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.passed, true);

  const event = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "outreach.quality_passed.v1" } });
  const payload = event.payload as { verdict: string; failedChecks: string[] };
  assert.equal(payload.verdict, "PASS");
  assert.deepEqual(payload.failedChecks, []);
});

test("execute() con Company DEMO_SEED: verdict=BLOCKED -- agentFailure(POLICY_BLOCKED), nunca se inventa que 'pasa'", async () => {
  const tenantId = await setupTenant("blocked");
  const executor = createQualityAgentExecutor();
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), baseInput({ companyOrigin: "DEMO_SEED" })));

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.category, "POLICY_BLOCKED");

  const event = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "outreach.quality_passed.v1" } });
  const payload = event.payload as { verdict: string; failedChecks: string[] };
  assert.equal(payload.verdict, "BLOCKED", "el evento se publica igual, aunque la tarea termine en agentFailure");
  assert.ok(payload.failedChecks.includes("company_valid"));
});

test("execute() con hasOtherActiveDuplicateApproval: verdict=HUMAN_REVIEW -- agentFailure(HUMAN_ACTION_REQUIRED) + crea HumanReviewRequest real", async () => {
  const tenantId = await setupTenant("human-review");
  const executor = createQualityAgentExecutor();
  const input = baseInput({ hasOtherActiveDuplicateApproval: true });
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), input));

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.category, "HUMAN_ACTION_REQUIRED");

  const review = await prisma.humanReviewRequest.findFirstOrThrow({ where: { tenantId, entityType: "approval_request", entityId: input.approvalRequestId } });
  assert.equal(review.type, "POLICY_EXCEPTION");
  assert.equal(review.resolvedAt, null);
});

test("execute() con placeholder sin resolver: verdict=NEEDS_REVISION -- agentSuccess (se arregla editando, no bloquea la tarea)", async () => {
  const tenantId = await setupTenant("needs-revision");
  const executor = createQualityAgentExecutor();
  const result = await withTenant(tenantId, () => executor.execute(fakeContext(tenantId), baseInput({ body: "Saludos, [Tu Nombre]." })));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.passed, false);
  assert.ok(result.output.failures.some((f) => f.check === "no_placeholders"));

  const event = await prisma.domainEvent.findFirstOrThrow({ where: { tenantId, type: "outreach.quality_passed.v1" } });
  assert.equal((event.payload as { verdict: string }).verdict, "NEEDS_REVISION");
});
