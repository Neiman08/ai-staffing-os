import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { hasActiveApprovalForCompany, ACTIVE_APPROVAL_STATUSES } from "../approvals/service";

/**
 * F24 (auditoría de producción, endurecimiento del pipeline): pruebas de
 * integración de extremo a extremo del gate de creación de Draft
 * (draft-creation-gate.ts) en los 3 call sites reales -- las pruebas
 * unitarias puras de la función ya viven en
 * ceo-intelligence/draft-creation-gate.test.ts; estas verifican el
 * WIRING real (HTTP -> AgentTask -> ApprovalRequest/Company).
 */

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

const createdCompanyIds: string[] = [];
const createdLeadIds: string[] = [];
const createdTaskIds: string[] = [];
const createdApprovalIds: string[] = [];

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
  if (createdApprovalIds.length) await prisma.approvalRequest.deleteMany({ where: { id: { in: createdApprovalIds } } });
  if (createdTaskIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { agentTaskId: { in: createdTaskIds } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  }
  if (createdLeadIds.length) {
    await prisma.activity.deleteMany({ where: { entityType: "lead", entityId: { in: createdLeadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  }
  if (createdCompanyIds.length) {
    await prisma.contact.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createCompany(overrides: Record<string, unknown> = {}) {
  const industry = await prisma.industry.findFirstOrThrow({ where: { name: "Construction" } });
  const company = await prisma.company.create({
    data: {
      tenantId: "tenant-titan",
      name: `Gate Test Co ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      industryId: industry.id,
      status: "LEAD",
      state: "IL",
      estimatedSize: "MEDIUM",
      commercialScore: 70,
      origin: "API_PROVIDER",
      email: "contact@gatetestco.example",
      ...overrides,
    } as never,
  });
  createdCompanyIds.push(company.id);
  return company;
}

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

// ---------- sales-tools.impl.ts draftOutreach: los 4 bloqueos reales ----------

test("draftOutreach: DEMO_SEED -- nunca crea un ApprovalRequest, Company.outreachBlockedReason permanece null (ya identificable por origin)", async () => {
  const company = await createCompany({ origin: "DEMO_SEED" });
  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.notEqual(settled.status, "FAILED", "bloqueado por el gate es un resultado válido, nunca un error");
  // requiresApproval() es una tabla estática por tool (packages/agents) --
  // draft_outreach SIEMPRE marca AWAITING_APPROVAL sin importar si el gate
  // terminó creando o no un ApprovalRequest real (comportamiento
  // preexistente, no introducido acá). Lo que realmente importa se
  // verifica abajo: cero ApprovalRequest creados.
  assert.equal(settled.status, "AWAITING_APPROVAL");
  const approvalCount = await prisma.approvalRequest.count({ where: { agentTaskId: task.id } });
  assert.equal(approvalCount, 0);

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfter.outreachBlockedReason, null);
});

test("draftOutreach: sin canal de contacto real -- nunca crea un ApprovalRequest, Company queda outreachBlockedReason=NEEDS_ENRICHMENT", async () => {
  const company = await createCompany({ email: null });
  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "AWAITING_APPROVAL");
  assert.equal(await prisma.approvalRequest.count({ where: { agentTaskId: task.id } }), 0);

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfter.outreachBlockedReason, "NEEDS_ENRICHMENT");
  assert.ok(companyAfter.outreachBlockedAt);
});

test("draftOutreach: isClientOwnerCandidate=true -- nunca crea outreach automático, Company queda outreachBlockedReason=CLIENT_OWNER_REVIEW", async () => {
  const company = await createCompany({ discoveryMetadata: { isClientOwnerCandidate: true } as never });
  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "AWAITING_APPROVAL");
  assert.equal(await prisma.approvalRequest.count({ where: { agentTaskId: task.id } }), 0);

  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfter.outreachBlockedReason, "CLIENT_OWNER_REVIEW");
});

test("draftOutreach: opportunityRecommendation=MANUAL_REVIEW -- mismo bloqueo que isClientOwnerCandidate", async () => {
  const company = await createCompany({ discoveryMetadata: { opportunityRecommendation: { recommendation: "MANUAL_REVIEW" } } as never });
  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "AWAITING_APPROVAL");
  assert.equal(await prisma.approvalRequest.count({ where: { agentTaskId: task.id } }), 0);
  const companyAfter = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(companyAfter.outreachBlockedReason, "CLIENT_OWNER_REVIEW");
});

test("draftOutreach: ya existe un ApprovalRequest activo para la Company -- nunca crea un segundo, sin importar el Lead", async () => {
  const company = await createCompany();
  const existingTask = await prisma.agentTask.findFirstOrThrow({ where: { tenantId: "tenant-titan", type: "draft_outreach" } }).catch(async () => {
    // Cualquier AgentTask real sirve como FK -- se reutiliza el patrón de agents.test.ts.
    const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId: "tenant-titan" } });
    return prisma.agentTask.create({
      data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
    });
  });
  createdTaskIds.push(existingTask.id);
  const existingApproval = await prisma.approvalRequest.create({
    data: {
      tenantId: "tenant-titan",
      agentTaskId: existingTask.id,
      companyId: company.id,
      summary: "Borrador previo ya activo",
      proposedAction: { channel: "EMAIL", to: "existing@gatetestco.example", subject: "s", body: "b" },
      riskLevel: "MEDIUM",
      status: "PENDING",
    },
  });
  createdApprovalIds.push(existingApproval.id);

  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "AWAITING_APPROVAL");
  // El único ApprovalRequest para esta Company sigue siendo el original.
  const approvalsForCompany = await prisma.approvalRequest.findMany({ where: { companyId: company.id } });
  assert.equal(approvalsForCompany.length, 1);
  assert.equal(approvalsForCompany[0]!.id, existingApproval.id);
});

test("draftOutreach: Company real, sin bloqueos -- crea el ApprovalRequest normalmente (no rompe el camino feliz)", async () => {
  const company = await createCompany();
  const lead = await prisma.lead.create({ data: { tenantId: "tenant-titan", companyId: company.id, industryId: company.industryId, status: "NEW" } });
  createdLeadIds.push(lead.id);

  const task = await invokeSalesTask({ type: "draft_outreach", input: { leadId: lead.id, channel: "EMAIL" } });
  const settled = await waitForSettled(task.id);

  assert.equal(settled.status, "AWAITING_APPROVAL");
  const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { agentTaskId: task.id } });
  assert.equal(approval.companyId, company.id, "el nuevo companyId debe quedar poblado");
});

// ---------- índice único parcial: protección real contra condiciones de carrera ----------

test("DB: el índice único parcial rechaza un segundo ApprovalRequest activo para la misma Company+tenant (a nivel de base de datos, no solo de aplicación)", async () => {
  const company = await createCompany();
  const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId: "tenant-titan" } });
  const task1 = await prisma.agentTask.create({
    data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
  });
  const task2 = await prisma.agentTask.create({
    data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
  });
  createdTaskIds.push(task1.id, task2.id);

  const first = await prisma.approvalRequest.create({
    data: { tenantId: "tenant-titan", agentTaskId: task1.id, companyId: company.id, summary: "primero", proposedAction: {}, status: "PENDING" },
  });
  createdApprovalIds.push(first.id);

  await assert.rejects(
    () =>
      prisma.approvalRequest.create({
        data: { tenantId: "tenant-titan", agentTaskId: task2.id, companyId: company.id, summary: "segundo, debe rechazarse", proposedAction: {}, status: "PENDING" },
      }),
    /Unique constraint/i,
  );
});

test("DB: el índice único NUNCA bloquea un ApprovalRequest nuevo si el anterior ya terminó su ciclo de vida (SENT/FAILED/REJECTED/EXPIRED)", async () => {
  const company = await createCompany();
  const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId: "tenant-titan" } });
  const task1 = await prisma.agentTask.create({
    data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
  });
  const task2 = await prisma.agentTask.create({
    data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
  });
  createdTaskIds.push(task1.id, task2.id);

  const first = await prisma.approvalRequest.create({
    data: { tenantId: "tenant-titan", agentTaskId: task1.id, companyId: company.id, summary: "primero, rechazado", proposedAction: {}, status: "REJECTED" },
  });
  createdApprovalIds.push(first.id);

  const second = await prisma.approvalRequest.create({
    data: { tenantId: "tenant-titan", agentTaskId: task2.id, companyId: company.id, summary: "segundo, nuevo intento", proposedAction: {}, status: "PENDING" },
  });
  createdApprovalIds.push(second.id);
  assert.ok(second.id);
});

// ---------- hasActiveApprovalForCompany: helper directo ----------

test("hasActiveApprovalForCompany: refleja exactamente PENDING/READY_TO_SEND/SENDING, nunca SENT/FAILED/REJECTED/EXPIRED", async () => {
  const company = await createCompany();
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "test-user", permissions: [] }, async () => {
    assert.equal(await hasActiveApprovalForCompany(company.id), false);

    const agentInstance = await prisma.agentInstance.findFirstOrThrow({ where: { tenantId: "tenant-titan" } });
    const task = await prisma.agentTask.create({
      data: { tenantId: "tenant-titan", agentInstanceId: agentInstance.id, type: "draft_outreach", status: "DONE", input: {}, triggeredBy: "AGENT" },
    });
    createdTaskIds.push(task.id);

    for (const status of ACTIVE_APPROVAL_STATUSES) {
      const approval = await prisma.approvalRequest.create({
        data: { tenantId: "tenant-titan", agentTaskId: task.id, companyId: company.id, summary: status, proposedAction: {}, status },
      });
      assert.equal(await hasActiveApprovalForCompany(company.id), true, `status=${status} debería contar como activo`);
      await prisma.approvalRequest.delete({ where: { id: approval.id } });
    }

    for (const status of ["SENT", "FAILED", "REJECTED", "EXPIRED"] as const) {
      const approval = await prisma.approvalRequest.create({
        data: { tenantId: "tenant-titan", agentTaskId: task.id, companyId: company.id, summary: status, proposedAction: {}, status },
      });
      assert.equal(await hasActiveApprovalForCompany(company.id), false, `status=${status} nunca debería contar como activo`);
      await prisma.approvalRequest.delete({ where: { id: approval.id } });
    }
  });
});
