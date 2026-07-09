import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };

const createdLeadIds: string[] = [];
const createdTaskIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  // FK order matters: ApprovalRequest -> AgentTask (real FK, no cascade).
  // Lead.createdByAgentTaskId has no FK (decisión #2: refs de actor sin
  // @relation), so it can be deleted in any order relative to AgentTask.
  if (createdLeadIds.length) {
    await prisma.activity.deleteMany({ where: { entityType: "lead", entityId: { in: createdLeadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  }
  if (createdTaskIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { agentTaskId: { in: createdTaskIds } } });
    await prisma.auditLog.deleteMany({ where: { action: { in: ["approval.decided"] } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function invokeSalesTask(body: unknown): Promise<{ id: string; status: string }> {
  const res = await fetch(`${baseUrl}/api/v1/agents/sales/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 202);
  const task = (await res.json()) as { id: string; status: string };
  createdTaskIds.push(task.id);
  return task;
}

async function waitForSettled(taskId: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/agents/tasks/${taskId}`, { headers: SALES_HEADERS });
    const task = (await res.json()) as { status: string };
    if (task.status !== "QUEUED" && task.status !== "RUNNING") return task as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`AgentTask ${taskId} did not settle within ${timeoutMs}ms`);
}

test("POST /agents/sales/tasks as compliance@titan.dev returns 403 (no agents.execute)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/agents/sales/tasks`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ type: "search_companies", input: {} }),
  });
  assert.equal(res.status, 403);
});

test("GET /approvals as compliance@titan.dev returns 403 (no approvals.decide)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/approvals`, { headers: COMPLIANCE_HEADERS });
  assert.equal(res.status, 403);
});

test("budget guard: an exhausted monthly budget fails the task before calling OpenAI", async () => {
  await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '0.0001') WHERE id = 'tenant-titan'`;

  const task = await invokeSalesTask({ type: "score_company", input: { companyId: "company-01" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "FAILED");
  assert.match(settled.errorMessage as string, /[Pp]resupuesto/);
  assert.equal(settled.tokensUsed, null, "a budget-rejected task must never have called OpenAI");

  await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '50') WHERE id = 'tenant-titan'`;
});

test("createLead: agent-created leads are marked with createdByAgentTaskId and aiScoreReason", async () => {
  const task = await invokeSalesTask({
    type: "create_lead",
    input: { companyId: "company-01", source: "referral" },
  });
  const settled = await waitForSettled(task.id);
  assert.equal(settled.status, "DONE");

  const leadId = (settled.output as { leadId: string }).leadId;
  createdLeadIds.push(leadId);

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  assert.equal(lead.createdByAgentTaskId, task.id);
  assert.ok(lead.aiScoreReason && lead.aiScoreReason.length > 0, "aiScoreReason must be populated");
  assert.ok(typeof lead.aiScore === "number" && lead.aiScore >= 0 && lead.aiScore <= 10);
});

test("scoreCompany: hybrid score is in range and persists a rationale (eval-style, real OpenAI call)", async () => {
  const task = await invokeSalesTask({ type: "score_company", input: { companyId: "company-01" } });
  const settled = await waitForSettled(task.id);
  assert.equal(settled.status, "DONE");

  const output = settled.output as { score: number; rationale: string };
  assert.ok(output.score >= 0 && output.score <= 100);
  // company-01: active industry (Construction) + LARGE + decision-role
  // contact — strong deterministic base (>= 65 before any LLM adjustment,
  // capped at ±10) — a real "golden case" floor, not an exact match.
  assert.ok(output.score >= 50, `expected a strong score for a well-matched company, got ${output.score}`);
  assert.ok(output.rationale.length > 0);

  const res = await fetch(`${baseUrl}/api/v1/companies/company-01`, { headers: SALES_HEADERS });
  const company = (await res.json()) as { commercialScoreReason: string | null };
  assert.equal(company.commercialScoreReason, output.rationale);
});

test("draftOutreach: never sends anything, always ends in a PENDING ApprovalRequest (real OpenAI call)", async () => {
  const leadTask = await invokeSalesTask({ type: "create_lead", input: { companyId: "company-01", source: "referral" } });
  const leadSettled = await waitForSettled(leadTask.id);
  const leadId = (leadSettled.output as { leadId: string }).leadId;
  createdLeadIds.push(leadId);

  const draftTask = await invokeSalesTask({ type: "draft_outreach", input: { leadId, channel: "EMAIL" } });
  const settled = await waitForSettled(draftTask.id);

  assert.equal(settled.status, "AWAITING_APPROVAL", "draftOutreach must never auto-complete — always awaits a human");
  assert.ok(settled.approvalRequestId, "must have created an ApprovalRequest");

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: settled.approvalRequestId as string } });
  assert.equal(approval.status, "PENDING");
  const action = approval.proposedAction as { channel: string; body: string; subject?: string };
  assert.equal(action.channel, "EMAIL");
  assert.ok(action.body.length > 0);
  // Structural guarantee that nothing was sent: the proposed action is
  // only ever a draft shape, never anything resembling a send receipt.
  assert.ok(!("sentAt" in action) && !("messageId" in action));

  // Approve it through the real endpoint and confirm the task closes out.
  const decideRes = await fetch(`${baseUrl}/api/v1/approvals/${approval.id}/decide`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ decision: "APPROVED", note: "test" }),
  });
  assert.equal(decideRes.status, 200);

  const finalTask = await prisma.agentTask.findUniqueOrThrow({ where: { id: draftTask.id } });
  assert.equal(finalTask.status, "DONE");
});
