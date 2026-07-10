import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };
const COMPLIANCE_HEADERS = { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" };

const createdCompanyIds: string[] = [];
const createdCampaignIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

async function cleanupCompany(companyId: string): Promise<void> {
  // CampaignCompany tiene FK real (ON DELETE RESTRICT) hacia Company —
  // hay que borrarla antes, junto con todo lo que cuelga de ella.
  const ccRows = await prisma.campaignCompany.findMany({ where: { companyId }, select: { id: true } });
  const ccIds = ccRows.map((c) => c.id);
  if (ccIds.length > 0) {
    await prisma.followUp.deleteMany({ where: { entityType: "company", entityId: companyId, campaignId: { not: null } } });
    await prisma.activity.deleteMany({ where: { entityType: "campaignCompany", entityId: { in: ccIds } } });
    await prisma.campaignCompany.deleteMany({ where: { id: { in: ccIds } } });
  }

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
  await prisma.agentTask.deleteMany({ where: { id: { in: [...taskIds] } } });
  await prisma.auditLog.deleteMany({ where: { OR: entityFilters } });

  await prisma.opportunity.deleteMany({ where: { companyId } });
  await prisma.lead.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
}

after(async () => {
  for (const id of createdCompanyIds) {
    await cleanupCompany(id).catch((err) => console.error(`cleanup failed for company ${id}:`, err));
  }
  for (const id of createdCampaignIds) {
    await prisma.campaign.delete({ where: { id } }).catch(() => {});
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

async function importTestCompany(namePrefix: string, industryName = "Construction"): Promise<string> {
  const uniqueName = `${namePrefix} ${Date.now()}`;
  const res = await fetch(`${baseUrl}/api/v1/prospecting/import`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ rows: [{ name: uniqueName, industryName, city: "Peoria", state: "IL" }] }),
  });
  const body = (await res.json()) as { companyIds: string[] };
  const companyId = body.companyIds[0]!;
  createdCompanyIds.push(companyId);
  return companyId;
}

test("POST /campaigns as compliance@titan.dev returns 403 (no campaigns.create)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ name: "Should not be allowed" }),
  });
  assert.equal(res.status, 403);
});

test("POST /campaigns/:id/tasks as compliance@titan.dev returns 403 (no agents.execute)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/campaigns/nonexistent/tasks`, {
    method: "POST",
    headers: COMPLIANCE_HEADERS,
    body: JSON.stringify({ type: "measure_campaign", input: {} }),
  });
  assert.equal(res.status, 403);
});

test("createCampaign reuses an existing DRAFT/ACTIVE campaign with equivalent criteria instead of duplicating it", async () => {
  const name = `Dedup Test ${Date.now()}`;
  const uniqueCity = `DedupCity${Date.now()}`;

  const res1 = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ name, state: "IL", city: uniqueCity }),
  });
  const body1 = (await res1.json()) as { campaignId: string; reused: boolean };
  assert.equal(body1.reused, false);
  createdCampaignIds.push(body1.campaignId);

  const res2 = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ name: `${name} — attempt 2`, state: "IL", city: uniqueCity }),
  });
  const body2 = (await res2.json()) as { campaignId: string; reused: boolean };
  assert.equal(body2.reused, true);
  assert.equal(body2.campaignId, body1.campaignId, "a second call with equivalent criteria must reuse, not duplicate");

  const campaignCount = await prisma.campaign.count({ where: { state: "IL", city: uniqueCity } });
  assert.equal(campaignCount, 1);
});

test("selectTargetCompanies excludes a company already TARGETED in another ACTIVE campaign", async () => {
  const companyId = await importTestCompany("Excl Co");
  await prisma.company.update({ where: { id: companyId }, data: { commercialScore: 80 } });

  const uniqueCity = `ExclusionCity${Date.now()}`;
  await prisma.company.update({ where: { id: companyId }, data: { city: uniqueCity } });

  // Dos campañas DISTINTAS (creadas directamente, sin pasar por el dedup
  // de createCampaign) que apuntan a la misma empresa — simula el caso
  // real de dos campañas independientes con criterios que calzan.
  const campaign1 = await prisma.campaign.create({
    data: { tenantId: "tenant-titan", name: `Campaign A ${Date.now()}`, status: "ACTIVE", city: uniqueCity },
  });
  const campaign2 = await prisma.campaign.create({
    data: { tenantId: "tenant-titan", name: `Campaign B ${Date.now()}`, status: "ACTIVE", city: uniqueCity },
  });
  createdCampaignIds.push(campaign1.id, campaign2.id);

  const select1 = await fetch(`${baseUrl}/api/v1/campaigns/${campaign1.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "select_target_companies", input: {} }),
  });
  const select1Body = (await select1.json()) as { id: string };
  const settled1 = await waitForSettled(select1Body.id);
  assert.equal(settled1.status, "DONE");
  assert.deepEqual((settled1.output as { companyIds: string[] }).companyIds, [companyId]);

  const select2 = await fetch(`${baseUrl}/api/v1/campaigns/${campaign2.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "select_target_companies", input: {} }),
  });
  const select2Body = (await select2.json()) as { id: string };
  const settled2 = await waitForSettled(select2Body.id);
  assert.equal(settled2.status, "DONE");
  assert.deepEqual(
    (settled2.output as { companyIds: string[] }).companyIds,
    [],
    "a company already TARGETED in an active campaign must not be selected into a second one",
  );
});

test("planSequence is idempotent and personalizeMessage always creates a PENDING ApprovalRequest (real OpenAI calls)", async () => {
  const companyId = await importTestCompany("Sequence Co", "Manufacturing");
  await prisma.company.update({ where: { id: companyId }, data: { commercialScore: 90 } });

  const campaign = await prisma.campaign.create({
    data: { tenantId: "tenant-titan", name: `Sequence Campaign ${Date.now()}`, status: "ACTIVE" },
  });
  createdCampaignIds.push(campaign.id);
  const cc = await prisma.campaignCompany.create({
    data: { tenantId: "tenant-titan", campaignId: campaign.id, companyId },
  });

  const plan1 = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "plan_sequence", input: {} }),
  });
  const plan1Settled = await waitForSettled(((await plan1.json()) as { id: string }).id);
  assert.equal(plan1Settled.status, "DONE");
  const followUpIds1 = (plan1Settled.output as { followUpIds: string[]; alreadyExisted: boolean }).followUpIds;
  assert.equal(followUpIds1.length, 4);

  const plan2 = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "plan_sequence", input: {} }),
  });
  const plan2Settled = await waitForSettled(((await plan2.json()) as { id: string }).id);
  const plan2Output = plan2Settled.output as { followUpIds: string[]; alreadyExisted: boolean };
  assert.equal(plan2Output.alreadyExisted, true, "planSequence must not create a second batch of FollowUps");
  assert.deepEqual(plan2Output.followUpIds, followUpIds1);

  const draft = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "personalize_message", input: { step: 0 } }),
  });
  const draftSettled = await waitForSettled(((await draft.json()) as { id: string }).id, 30_000);
  assert.equal(draftSettled.status, "AWAITING_APPROVAL");
  assert.ok(draftSettled.approvalRequestId);

  const approval = await prisma.approvalRequest.findUniqueOrThrow({
    where: { id: draftSettled.approvalRequestId as string },
  });
  assert.equal(approval.status, "PENDING");
  const proposedAction = approval.proposedAction as { body: string; subject: string };
  assert.ok(proposedAction.body.length > 0);

  const step0FollowUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpIds1[0]! } });
  assert.equal(step0FollowUp.status, "DONE", "personalizeMessage must mark its target step DONE so the scheduler never redrafts it");
});

test("classifyConversation classifies a clearly positive reply and marks the company HOT (real OpenAI call)", async () => {
  const companyId = await importTestCompany("Conversation Co", "Warehouse/Logistics");
  const campaign = await prisma.campaign.create({
    data: { tenantId: "tenant-titan", name: `Conversation Campaign ${Date.now()}`, status: "ACTIVE" },
  });
  createdCampaignIds.push(campaign.id);
  const cc = await prisma.campaignCompany.create({
    data: { tenantId: "tenant-titan", campaignId: campaign.id, companyId },
  });

  const res = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/conversation`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({
      replyText: "Sí, estamos muy interesados, nos encantaría agendar una llamada esta semana para conocer más.",
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { intent: string; newStatus: string; rationale: string };
  assert.ok(["INTERESTED", "VERY_INTERESTED"].includes(body.intent));
  assert.equal(body.newStatus, "HOT");
  assert.ok(body.rationale.length > 0);

  const updated = await prisma.campaignCompany.findUniqueOrThrow({ where: { id: cc.id } });
  assert.equal(updated.status, "HOT");
  assert.ok(updated.lastIntent);

  const activities = await prisma.activity.findMany({ where: { entityType: "campaignCompany", entityId: cc.id } });
  assert.equal(activities.length, 2, "one Activity for the logged reply, one for the classification");
});

test("budget guard: an exhausted monthly budget fails personalizeMessage before calling OpenAI", async () => {
  const companyId = await importTestCompany("Budget Co", "Construction");
  await prisma.company.update({ where: { id: companyId }, data: { commercialScore: 70 } });
  const campaign = await prisma.campaign.create({
    data: { tenantId: "tenant-titan", name: `Budget Campaign ${Date.now()}`, status: "ACTIVE" },
  });
  createdCampaignIds.push(campaign.id);
  const cc = await prisma.campaignCompany.create({
    data: { tenantId: "tenant-titan", campaignId: campaign.id, companyId },
  });
  const planRes = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/tasks`, {
    method: "POST",
    headers: SALES_HEADERS,
    body: JSON.stringify({ type: "plan_sequence", input: {} }),
  });
  await waitForSettled(((await planRes.json()) as { id: string }).id);

  await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '0.0001') WHERE id = 'tenant-titan'`;
  try {
    const res = await fetch(`${baseUrl}/api/v1/campaign-companies/${cc.id}/tasks`, {
      method: "POST",
      headers: SALES_HEADERS,
      body: JSON.stringify({ type: "personalize_message", input: { step: 0 } }),
    });
    const settled = await waitForSettled(((await res.json()) as { id: string }).id);
    assert.equal(settled.status, "FAILED");
    assert.match(settled.errorMessage as string, /[Pp]resupuesto/);
    assert.equal(settled.tokensUsed, null);
  } finally {
    await prisma.$executeRaw`UPDATE "Tenant" SET settings = jsonb_set(settings, '{aiMonthlyBudgetUsd}', '50') WHERE id = 'tenant-titan'`;
  }
});
