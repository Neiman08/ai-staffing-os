import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { decideApproval, regenerateApprovalDraft } from "./service";
import { fakeDraftLLMProvider } from "../agents/draft-generation.test-support";

/**
 * "Regenerate Draft": re-redacta un ApprovalRequest existente con la
 * evidencia real y actual de la Company (ver approvals/service.ts's
 * regenerateApprovalDraft) -- pensado para borradores viejos generados
 * en español, antes del rediseño de idioma/personalización. Nunca
 * envía nada, nunca cambia el destinatario (`to` se preserva).
 */

const TEST_PREFIX = "REGEN-DRAFT-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  const industry = await prisma.industry.create({ data: { tenantId: tenant.id, name: "Construction", isGlobal: false } });
  const discoveryDefinition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key: "discovery" } });
  const agentInstance = await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: discoveryDefinition.id, isActive: true } });
  const agentTask = await prisma.agentTask.create({
    data: { tenantId: tenant.id, agentInstanceId: agentInstance.id, type: "draft_outreach", status: "AWAITING_APPROVAL", triggeredBy: "AGENT", input: {} },
  });
  return { tenantId: tenant.id, industryId: industry.id, agentTaskId: agentTask.id };
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.contact.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.industry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function createSpanishApproval(tenantId: string, agentTaskId: string, companyId: string, overrides: Record<string, unknown> = {}) {
  return prisma.approvalRequest.create({
    data: {
      tenantId,
      agentTaskId,
      companyId,
      summary: "Borrador viejo en español",
      proposedAction: {
        channel: "EMAIL",
        companyId,
        to: "info@old-draft.example",
        subject: "Posible colaboración con Old Draft Co",
        body: "Hola,\n\nVimos que Old Draft Co podría estar buscando personal.\n\nSaludos.",
        ...overrides,
      },
      riskLevel: "MEDIUM",
    },
  });
}

test("regenerateApprovalDraft: PENDING se regenera con evidencia real, preserva `to`, permanece PENDING", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("pending");
  const company = await prisma.company.create({
    data: { tenantId, name: "Old Draft Co", industryId, status: "LEAD", city: "Chicago", state: "IL", email: "info@old-draft.example" },
  });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createSpanishApproval(tenantId, agentTaskId, company.id);
    const { provider } = fakeDraftLLMProvider();
    const result = await regenerateApprovalDraft(approval.id, { llmProvider: provider });

    assert.equal(result.status, "PENDING");
    const pa = result.proposedAction as { to: string; subject: string; body: string; draftMetadata?: { language?: string; companyName?: string } };
    assert.equal(pa.to, "info@old-draft.example", "el destinatario nunca cambia al regenerar");
    assert.notEqual(pa.subject, "Posible colaboración con Old Draft Co", "el asunto viejo/genérico debe reemplazarse");
    assert.doesNotMatch(pa.body, /Vimos que Old Draft Co podría estar buscando personal/, "el cuerpo viejo en español debe reemplazarse");
    assert.equal(pa.draftMetadata?.language, "en");
    assert.equal(pa.draftMetadata?.companyName, "Old Draft Co");
  });
});

test("regenerateApprovalDraft: READY_TO_SEND se regenera y VUELVE a PENDING (requiere nueva aprobación)", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("ready");
  const company = await prisma.company.create({
    data: { tenantId, name: "Ready Regen Co", industryId, status: "LEAD", city: "Austin", state: "TX", email: "info@old-draft.example" },
  });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createSpanishApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "APPROVED" });
    const readyState = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(readyState.status, "READY_TO_SEND");

    const { provider } = fakeDraftLLMProvider();
    const result = await regenerateApprovalDraft(approval.id, { llmProvider: provider });
    assert.equal(result.status, "PENDING");
  });
});

test("regenerateApprovalDraft: bloquea la regeneración de un ApprovalRequest REJECTED", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("rejected-blocked");
  const company = await prisma.company.create({ data: { tenantId, name: "Rejected Regen Co", industryId, status: "LEAD", email: "info@old-draft.example" } });

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await createSpanishApproval(tenantId, agentTaskId, company.id);
    await decideApproval(approval.id, { decision: "REJECTED" });

    await assert.rejects(
      () => regenerateApprovalDraft(approval.id, { llmProvider: fakeDraftLLMProvider().provider }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});

test("regenerateApprovalDraft registra auditoría: quién, cuándo, subject/body anteriores y nuevos", async () => {
  const { tenantId, industryId, agentTaskId } = await setupTenant("audit");
  const company = await prisma.company.create({
    data: { tenantId, name: "Audited Regen Co", industryId, status: "LEAD", city: "Miami", state: "FL", email: "info@old-draft.example" },
  });

  await runWithTenancyContext({ tenantId, userId: "test-user-regen", permissions: [] }, async () => {
    const approval = await createSpanishApproval(tenantId, agentTaskId, company.id);
    await regenerateApprovalDraft(approval.id, { llmProvider: fakeDraftLLMProvider().provider });
  });

  const log = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "approval.draft_regenerated" } });
  assert.equal(log.actorId, "test-user-regen");
  assert.equal(log.actorType, "HUMAN");
  const before = log.before as Record<string, unknown>;
  assert.equal(before.subject, "Posible colaboración con Old Draft Co");
});

test("regenerateApprovalDraft: sin companyId asociado, rechaza con 400 en vez de generar sin evidencia", async () => {
  const { tenantId, agentTaskId } = await setupTenant("no-company");

  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, async () => {
    const approval = await prisma.approvalRequest.create({
      data: {
        tenantId,
        agentTaskId,
        summary: "Borrador sin Company asociada",
        proposedAction: { channel: "EMAIL", to: "someone@example.com", subject: "s", body: "b" },
        riskLevel: "MEDIUM",
      },
    });

    await assert.rejects(
      () => regenerateApprovalDraft(approval.id, { llmProvider: fakeDraftLLMProvider().provider }),
      (err: unknown) => err instanceof AppError && err.status === 400,
    );
  });
});
