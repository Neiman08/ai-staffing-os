import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY_ENVELOPE } from "@ai-staffing-os/agents";
import { evaluateDraftCreationGate } from "../../ceo-intelligence/draft-creation-gate";
import { evaluateApprovalQualityGate } from "../../ceo-intelligence/approval-quality-gate";
import { resolveBestContactChannel } from "../../ceo-intelligence/contact-channel";
import { findKnownPlaceholders } from "@ai-staffing-os/shared";
import { QUALITY_AGENT_CAPABILITIES, createQualityAgentExecutor, type QualityTaskInput } from "./quality.executor";

/**
 * F25.2 Fase 8: prueba (1) que QUALITY_AGENT_CAPABILITIES reexpone las
 * MISMAS referencias de función de F24 -- prueba de identidad, no solo
 * de comportamiento, para blindar contra una futura duplicación
 * accidental -- y (2) el wrapper AgentExecutor sobre
 * evaluateApprovalQualityGate. La lógica de los 8 checks en sí ya tiene
 * su batería completa en approval-quality-gate.test.ts.
 */

const FAKE_CONTEXT = {
  tenantId: "tenant-titan",
  agentInstanceId: "agentinstance_test",
  taskId: "task_test",
  triggeredBy: "AGENT" as const,
  correlationId: "mission_test",
  causationId: null,
  capabilities: [],
  policyEnvelope: DEFAULT_POLICY_ENVELOPE,
};

function baseInput(overrides: Partial<QualityTaskInput> = {}): QualityTaskInput {
  return {
    approvalRequestId: "approval_test",
    companyOrigin: "API_PROVIDER",
    companyCommercialStatus: "COMMERCIAL_VALIDATED",
    to: "contact@realcompany.example",
    subject: "Asunto real",
    body: "Cuerpo real, sin placeholders.",
    hasOtherActiveDuplicateApproval: false,
    ...overrides,
  };
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

test("execute() con un borrador válido delega a evaluateApprovalQualityGate real (passed=true) y publica outreach.quality_passed.v1 con verdict=PASS", async () => {
  const executor = createQualityAgentExecutor();
  const result = await executor.execute(FAKE_CONTEXT, baseInput());

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.passed, true);
  assert.deepEqual(result.output.failures, []);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.eventType, "outreach.quality_passed.v1");
  assert.deepEqual(result.events[0]!.payload, { approvalRequestId: "approval_test", verdict: "PASS", failedChecks: [] });
});

test("execute() con Company DEMO_SEED delega el fallo real (company_valid) y publica verdict=NEEDS_REVISION con el check exacto", async () => {
  const executor = createQualityAgentExecutor();
  const result = await executor.execute(FAKE_CONTEXT, baseInput({ companyOrigin: "DEMO_SEED" }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.passed, false);
  assert.ok(result.output.failures.some((f) => f.check === "company_valid"));
  const payload = result.events[0]!.payload as { verdict: string; failedChecks: string[] };
  assert.equal(payload.verdict, "NEEDS_REVISION");
  assert.ok(payload.failedChecks.includes("company_valid"));
});

test("execute() con placeholder sin resolver delega en findKnownPlaceholders vía evaluateApprovalQualityGate (no_placeholders)", async () => {
  const executor = createQualityAgentExecutor();
  const result = await executor.execute(FAKE_CONTEXT, baseInput({ body: "Saludos, [Tu Nombre]." }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.output.passed, false);
  assert.ok(result.output.failures.some((f) => f.check === "no_placeholders"));
});
