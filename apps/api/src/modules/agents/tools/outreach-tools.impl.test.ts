import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import type { LLMCompletionResult, LLMProvider } from "@ai-staffing-os/agents";
import { runWithTenancyContext } from "../../../core/tenancy/context";
import { createOutreachTools } from "./outreach-tools.impl";
import { UsageAccumulator } from "../usage";

/**
 * F21 Fase 2/3: personalizeMessage NUNCA debe crear un ApprovalRequest
 * (ni llamar al LLM) para una Company sin ningún canal de email real
 * disponible -- en ese caso debe crear una tarea comercial alternativa
 * (FollowUp) documentando el canal real que sí existe. Cuando SÍ hay un
 * canal de email, debe seguir generando el borrador de siempre.
 */

const TEST_PREFIX = "F21-OUTREACH-TEST";
const createdTenantIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdCampaignIds: string[] = [];

after(async () => {
  await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.followUp.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.campaignCompany.deleteMany({ where: { companyId: { in: createdCompanyIds } } });
  await prisma.campaign.deleteMany({ where: { id: { in: createdCampaignIds } } });
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  if (createdTenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

function throwingLLMProvider(): LLMProvider {
  return {
    complete: async (): Promise<LLMCompletionResult> => {
      throw new Error("outreach-tools.impl.test.ts: el LLM NUNCA debe llamarse cuando no hay canal de email real.");
    },
  };
}

function fakeLLMProvider(subject: string, body: string): LLMProvider {
  return {
    complete: async (): Promise<LLMCompletionResult> => ({
      content: JSON.stringify({ subject, body }),
      tokensUsed: 10,
      promptTokens: 5,
      completionTokens: 5,
    }),
  };
}

async function setupCampaignCompany(suffix: string, companyOverrides: Record<string, unknown> = {}) {
  const tenantId = `${TEST_PREFIX}-${suffix}`;
  const tenant = await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: `${tenantId.toLowerCase()}-${Date.now()}` } });
  createdTenantIds.push(tenant.id);

  const def = await prisma.agentDefinition.findFirstOrThrow({ where: { key: "outreach" } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: def.id, isActive: true } });
  const task = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: instance.id, type: "personalize_message", input: {}, status: "RUNNING", triggeredBy: "AGENT" },
  });

  const company = await prisma.company.create({
    data: {
      tenantId: tenant.id,
      name: `${TEST_PREFIX}-${suffix}-Hotel`,
      industryId: "industry-hospitality",
      status: "LEAD",
      ...companyOverrides,
    },
  });
  createdCompanyIds.push(company.id);

  const campaign = await prisma.campaign.create({
    data: { tenantId: tenant.id, name: `${TEST_PREFIX}-${suffix}-campaign`, industryId: "industry-hospitality", status: "ACTIVE" },
  });
  createdCampaignIds.push(campaign.id);

  const campaignCompany = await prisma.campaignCompany.create({
    data: { tenantId: tenant.id, campaignId: campaign.id, companyId: company.id },
  });

  return { tenantId: tenant.id, taskId: task.id, agentInstanceId: instance.id, companyId: company.id, campaignCompanyId: campaignCompany.id };
}

test("personalizeMessage: Company SIN ningún canal de email real -> nunca llama al LLM, nunca crea ApprovalRequest, crea tarea alternativa", async () => {
  const fx = await setupCampaignCompany("no-channel");

  await runWithTenancyContext({ tenantId: fx.tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const tools = createOutreachTools({
      taskId: fx.taskId,
      agentInstanceId: fx.agentInstanceId,
      llmProvider: throwingLLMProvider(),
      usage: new UsageAccumulator(),
    });
    const planSequence = tools.find((t) => t.name === "planSequence")!;
    await planSequence.execute({ campaignCompanyId: fx.campaignCompanyId });

    const personalizeMessage = tools.find((t) => t.name === "personalizeMessage")!;
    const result = (await personalizeMessage.execute({ campaignCompanyId: fx.campaignCompanyId, step: 0 })) as {
      draftBody: string | null;
      channel: string;
      alternativeChannelTaskId: string | null;
    };

    assert.equal(result.draftBody, null);
    assert.equal(result.channel, "NONE");
    assert.ok(result.alternativeChannelTaskId);
  });

  const approvals = await prisma.approvalRequest.findMany({ where: { tenantId: fx.tenantId } });
  assert.equal(approvals.length, 0, "nunca debe crear un ApprovalRequest sin canal de email real");
  const followUps = await prisma.followUp.findMany({ where: { entityType: "company", entityId: fx.companyId } });
  assert.ok(followUps.some((f) => f.notes?.includes("Sin email disponible")), "debe documentar el canal alternativo en un FollowUp real");
});

test("personalizeMessage: Company CON email organizacional real -> genera el borrador y crea el ApprovalRequest de siempre", async () => {
  const fx = await setupCampaignCompany("with-channel", { email: "info@testhotel.com" });

  let approvalCount = 0;
  await runWithTenancyContext({ tenantId: fx.tenantId, userId: `${TEST_PREFIX}-user`, permissions: ["missions.create"] }, async () => {
    const tools = createOutreachTools({
      taskId: fx.taskId,
      agentInstanceId: fx.agentInstanceId,
      llmProvider: fakeLLMProvider("Colaboración con nuestro equipo", "Hola equipo, ..."),
      usage: new UsageAccumulator(),
    });
    const planSequence = tools.find((t) => t.name === "planSequence")!;
    await planSequence.execute({ campaignCompanyId: fx.campaignCompanyId });

    const personalizeMessage = tools.find((t) => t.name === "personalizeMessage")!;
    const result = (await personalizeMessage.execute({ campaignCompanyId: fx.campaignCompanyId, step: 0 })) as {
      draftBody: string | null;
      channel: string;
      alternativeChannelTaskId: string | null;
    };

    assert.ok(result.draftBody);
    assert.equal(result.channel, "WEBSITE_ORG_EMAIL");
    assert.equal(result.alternativeChannelTaskId, null);
  });

  const approvals = await prisma.approvalRequest.findMany({ where: { tenantId: fx.tenantId } });
  approvalCount = approvals.length;
  assert.equal(approvalCount, 1);
  const proposedAction = approvals[0]!.proposedAction as { to?: string; contactChannelSource?: string };
  assert.equal(proposedAction.to, "info@testhotel.com");
  assert.equal(proposedAction.contactChannelSource, "WEBSITE_ORG_EMAIL");
});
