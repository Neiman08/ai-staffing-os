import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";
import { runProspectingSweep } from "../agents/scheduler";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };

const createdCompanyIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

/**
 * Lead/Opportunity tienen FK real hacia Company (sin cascade) — hay que
 * borrarlos antes que la Company. Contact sí cascadea (onDelete: Cascade
 * desde F0). AgentTask/ApprovalRequest/AgentMemory/Activity/AuditLog no
 * tienen FK real hacia Company (decisión #2), pero igual se limpian para
 * no dejar residuo asociado a una Company que ya no existe.
 */
async function cleanupCompanyCascade(companyId: string): Promise<void> {
  const leads = await prisma.lead.findMany({ where: { companyId }, select: { id: true } });
  const leadIds = leads.map((l) => l.id);
  const opportunities = await prisma.opportunity.findMany({ where: { companyId }, select: { id: true } });
  const opportunityIds = opportunities.map((o) => o.id);

  const entityFilters = [
    { entityType: "company", entityId: companyId },
    ...leadIds.map((id) => ({ entityType: "lead", entityId: id })),
    ...opportunityIds.map((id) => ({ entityType: "opportunity", entityId: id })),
  ];

  await prisma.followUp.deleteMany({ where: { OR: entityFilters } });
  await prisma.activity.deleteMany({ where: { OR: entityFilters } });

  // AgentTask no tiene FK real hacia Company/Lead/Opportunity (input/output
  // son Json) — se identifican por contenido con un scan simple, barato al
  // volumen de datos de test.
  const taskIds = new Set<string>();
  const allTasks = await prisma.agentTask.findMany({ select: { id: true, output: true, input: true } });
  for (const t of allTasks) {
    const output = t.output as { leadId?: string; opportunityId?: string } | null;
    const input = t.input as { companyId?: string; leadId?: string } | null;
    if (
      input?.companyId === companyId ||
      (input?.leadId && leadIds.includes(input.leadId)) ||
      (output?.leadId && leadIds.includes(output.leadId)) ||
      (output?.opportunityId && opportunityIds.includes(output.opportunityId))
    ) {
      taskIds.add(t.id);
    }
  }

  await prisma.approvalRequest.deleteMany({ where: { agentTaskId: { in: [...taskIds] } } });
  await prisma.agentMemory.deleteMany({ where: { OR: entityFilters } });
  await prisma.agentTask.deleteMany({ where: { id: { in: [...taskIds] } } });
  await prisma.auditLog.deleteMany({ where: { OR: entityFilters } });

  await prisma.opportunity.deleteMany({ where: { companyId } });
  await prisma.lead.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } }); // cascada Contact
}

after(async () => {
  for (const id of createdCompanyIds) {
    await cleanupCompanyCascade(id).catch((err) => console.error(`cleanup failed for ${id}:`, err));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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

test("POST /prospecting/import as compliance@titan.dev returns 403 (no companies.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ rows: [{ name: "X", industryName: "Construction" }] }),
  });
  assert.equal(res.status, 403);
});

test("POST /prospecting/tasks as compliance@titan.dev returns 403 (no agents.execute)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/prospecting/tasks`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ companyId: "company-01" }),
  });
  assert.equal(res.status, 403);
});

test("import: rejects an unknown industry (never invents one) and skips exact duplicates", async () => {
  const uniqueName = `Test Import Co ${Date.now()}`;
  const res = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      rows: [
        { name: uniqueName, industryName: "Construction", city: "Peoria", state: "IL" },
        { name: "Whatever Inc", industryName: "NoSuchIndustry" },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { importedCount: number; skipped: Array<{ row: number; reason: string }>; companyIds: string[] };
  assert.equal(body.importedCount, 1);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0]?.row, 1);
  assert.match(body.skipped[0]?.reason ?? "", /no existe/);
  createdCompanyIds.push(body.companyIds[0]!);

  // duplicado exacto (mismo nombre + industria) — se debe saltar, no crear una segunda fila
  const dupRes = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ rows: [{ name: uniqueName, industryName: "Construction" }] }),
  });
  const dupBody = (await dupRes.json()) as { importedCount: number; skipped: Array<{ reason: string }> };
  assert.equal(dupBody.importedCount, 0);
  assert.match(dupBody.skipped[0]?.reason ?? "", /Ya existe/);
});

test("processCompanyPipeline: full chain creates Lead/Opportunity/FollowUp and ends in a PENDING ApprovalRequest (real OpenAI calls)", async () => {
  const uniqueName = `Test Pipeline Co ${Date.now()}`;
  const importRes = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      rows: [
        {
          name: uniqueName,
          industryName: "Warehouse/Logistics",
          city: "Joliet",
          state: "IL",
          contactFirstName: "Pat",
          contactLastName: "Rivera",
          contactEmail: "pat@testpipeline.example",
        },
      ],
    }),
  });
  const importBody = (await importRes.json()) as { companyIds: string[] };
  const companyId = importBody.companyIds[0]!;
  createdCompanyIds.push(companyId);

  const contacts = await prisma.contact.findMany({ where: { companyId } });
  assert.equal(contacts.length, 1, "literal contact data from the import must create a real Contact");
  assert.equal(contacts[0]?.firstName, "Pat");

  const triggerRes = await fetch(`${baseUrl}/api/v1/prospecting/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ companyId }),
  });
  assert.equal(triggerRes.status, 202);
  const triggerBody = (await triggerRes.json()) as { id: string };

  const settled = await waitForSettled(triggerBody.id, 30_000);
  assert.equal(settled.status, "DONE");

  const output = settled.output as {
    leadId: string;
    opportunityId: string;
    followUpId: string;
    approvalRequestId: string;
  };
  assert.ok(output.leadId && output.opportunityId && output.followUpId && output.approvalRequestId);

  const children = await prisma.agentTask.findMany({ where: { parentTaskId: triggerBody.id } });
  assert.equal(children.length, 5, "score_company, create_lead, create_opportunity, create_follow_up, draft_outreach");
  assert.ok(children.every((c) => c.status === "DONE" || c.status === "AWAITING_APPROVAL"));

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: output.leadId } });
  assert.equal(lead.status, "CONVERTED");
  assert.ok(lead.aiScoreReason);

  const opportunity = await prisma.opportunity.findUniqueOrThrow({ where: { id: output.opportunityId } });
  assert.equal(opportunity.createdByAgentTaskId, children.find((c) => c.type === "create_opportunity")?.id);
  assert.equal(opportunity.estimatedPayRate, null, "the pipeline never sets rates — that stays human/Pricing Agent");
  assert.equal(opportunity.estimatedBillRate, null);

  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: output.approvalRequestId } });
  assert.equal(approval.status, "PENDING");

  const memory = await prisma.agentMemory.findFirst({ where: { entityType: "company", entityId: companyId } });
  assert.ok(memory, "the pipeline must leave a 'processed' memory marker for scheduler dedup");
});

test("scheduler: runProspectingSweep processes a newly imported company and skips it on the next run (real OpenAI calls)", async () => {
  const uniqueName = `Test Sweep Co ${Date.now()}`;
  const importRes = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ rows: [{ name: uniqueName, industryName: "Manufacturing" }] }),
  });
  const importBody = (await importRes.json()) as { companyIds: string[] };
  const companyId = importBody.companyIds[0]!;
  createdCompanyIds.push(companyId);

  await runProspectingSweep("tenant-titan");

  const memory = await prisma.agentMemory.findFirst({ where: { entityType: "company", entityId: companyId } });
  assert.ok(memory, "sweep must have processed the unprocessed company and left a memory marker");

  const lead = await prisma.lead.findFirst({ where: { companyId } });
  assert.ok(lead, "sweep's pipeline run must have created a real Lead");

  const secondSweep = await runProspectingSweep("tenant-titan");
  const memoriesAfterSecondSweep = await prisma.agentMemory.count({
    where: { entityType: "company", entityId: companyId },
  });
  assert.equal(memoriesAfterSecondSweep, 1, "a second sweep must not reprocess the same company");
  void secondSweep;
});

test("budget guard applies to the pipeline task itself: an exhausted budget fails it before any child task is created", async () => {
  // try/finally: si un assert falla a mitad de este test, el presupuesto
  // NO puede quedar atascado en $0.0001 para el resto de la suite (esto
  // pasó una vez durante el desarrollo — el reset vivía al final del
  // cuerpo del test y nunca se alcanzaba tras un assert fallido).
  await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '0.0001') WHERE id = 'tenant-titan'`;
  try {
    const res = await fetch(`${baseUrl}/api/v1/prospecting/tasks`, {
      method: "POST",
      headers: SALES_HEADERS,
      body: JSON.stringify({ companyId: "company-01" }),
    });
    const body = (await res.json()) as { id: string };
    const settled = await waitForSettled(body.id);

    assert.equal(settled.status, "FAILED");
    assert.match(settled.errorMessage as string, /[Pp]resupuesto/);
    assert.equal(settled.tokensUsed, null, "no child tool should ever have run, let alone called OpenAI");

    const children = await prisma.agentTask.findMany({ where: { parentTaskId: body.id } });
    assert.equal(children.length, 0, "the budget guard runs before the orchestrator dispatches any child task");
  } finally {
    await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '50') WHERE id = 'tenant-titan'`;
  }
});

test("GET /ai-dashboard/summary returns the full metrics shape with real data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/ai-dashboard/summary`, { headers: SALES_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of [
    "companiesAnalyzedToday",
    "newCompaniesToday",
    "leadsCreatedByAiToday",
    "averageScore",
    "costUsdThisMonth",
    "budgetUsd",
    "roiEstimate",
    "pendingProspects",
    "pendingApprovals",
    "companiesByIndustry",
    "companiesByState",
  ]) {
    assert.ok(key in body, `summary must include ${key}`);
  }
});
