import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createAndRunTaskSync } from "./task-executor";

/**
 * F29 (hallazgo real, MIS-20260729-0008, 2026-07-29): una misión real
 * terminó con la tarea `personalize_message` en status AWAITING_APPROVAL,
 * pero la pantalla de Approvals estaba completamente vacía -- ningún
 * ApprovalRequest existía para esa Company.
 *
 * Causa raíz: `executeTaskById` (task-executor.ts) decidía
 * `status: needsApproval ? "AWAITING_APPROVAL" : "DONE"` usando
 * ÚNICAMENTE `requiresApproval(toolName)` (ApprovalGate.ts) -- una tabla
 * estática por NOMBRE de tool ("personalizeMessage"/"draftOutreach"
 * siempre requieren aprobación). Pero ninguna de las dos tools garantiza
 * eso en TODAS sus ramas: si el gate de negocio (draft-creation-gate.ts)
 * bloquea la redacción (DEMO_SEED, duplicado activo, client-owner
 * candidate) o si la Company no tiene ningún canal de email real (solo
 * página de careers, teléfono o LinkedIn -- NEEDS_ENRICHMENT), ninguna
 * de las dos crea un ApprovalRequest -- pero el AgentTask igual quedaba
 * marcado AWAITING_APPROVAL. Como el único código que saca un AgentTask
 * de ese estado es decidir sobre un ApprovalRequest real
 * (approvals/service.ts:382), esas tareas quedaban huérfanas para
 * siempre: sin nada que aprobar, y sin forma de resolverse.
 *
 * El caso real (MIS-20260729-0008): "World Food Processing dba Puris"
 * no tenía ningún email ni contacto -- solo una página de careers real
 * en su sitio -- así que personalizeMessage creó correctamente un
 * FollowUp alternativo (nunca un Draft inventado), pero el AgentTask
 * quedó incorrectamente en AWAITING_APPROVAL.
 *
 * Fix: `needsApproval` ahora también exige que exista de verdad un
 * ApprovalRequest con `agentTaskId` = este task -- mismo criterio ya
 * usado en `getAgentTaskDetail` (service.ts) y `runChildTask`
 * (buildToolRegistry) para resolver `approvalRequestId`, nunca inferido
 * del nombre de la tool ni de su output.
 *
 * Estos tests reproducen exactamente los dos casos reales (personalizeMessage
 * sin canal de email, draftOutreach bloqueado por DEMO_SEED) sin costo real
 * de LLM -- ambas ramas resuelven el gate ANTES de llamar al proveedor.
 */

const TEST_PREFIX = "F29-APPROVAL-STATUS";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.followUp.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaignCompany.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.campaign.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.lead.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.company.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentTask.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.agentInstance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenantWithAgents(suffix: string, agentKeys: string[]) {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}-${Date.now()}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  for (const key of agentKeys) {
    const definition = await prisma.agentDefinition.findUniqueOrThrow({ where: { key } });
    await prisma.agentInstance.create({ data: { tenantId: tenant.id, definitionId: definition.id, isActive: true } });
  }
  return tenant;
}

test("personalize_message SIN canal de email real (solo careers page, caso real MIS-20260729-0008): el AgentTask termina DONE, nunca AWAITING_APPROVAL fantasma", async () => {
  const tenant = await setupTenantWithAgents("no-channel", ["outreach", "campaign"]);

  const result = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, async () => {
    const hospitality = await prisma.industry.findFirstOrThrow({ where: { name: "Hospitality", isGlobal: true } });
    const company = await prisma.company.create({
      data: {
        tenantId: tenant.id,
        name: "World Food Processing dba Puris (test)",
        industryId: hospitality.id,
        state: "IL",
        origin: "API_PROVIDER",
        commercialStatus: "COMMERCIAL_VALIDATED",
        // Sin email, sin contactos, sin contactPoints -- reproduce
        // exactamente la Company real de MIS-20260729-0008.
      },
    });
    const campaign = await prisma.campaign.create({
      data: { tenantId: tenant.id, name: "F29 test campaign", industryId: hospitality.id, state: "IL" },
    });
    const campaignCompany = await prisma.campaignCompany.create({
      data: { tenantId: tenant.id, campaignId: campaign.id, companyId: company.id },
    });

    const planTask = await createAndRunTaskSync(tenant.id, "test-user", {
      agentKey: "outreach",
      type: "plan_sequence",
      input: { campaignCompanyId: campaignCompany.id },
      triggeredBy: "AGENT",
    });
    assert.equal(planTask.status, "DONE");

    return createAndRunTaskSync(tenant.id, "test-user", {
      agentKey: "outreach",
      type: "personalize_message",
      input: { campaignCompanyId: campaignCompany.id, step: 0 },
      triggeredBy: "AGENT",
    });
  });

  assert.equal(result.status, "DONE", "sin ApprovalRequest real, el AgentTask nunca debe quedar AWAITING_APPROVAL");
  const output = result.output as { channel: string; alternativeChannelTaskId: string | null };
  assert.equal(output.channel, "NONE");
  assert.ok(output.alternativeChannelTaskId, "debe haber creado la tarea comercial alternativa (FollowUp), nunca un Draft inventado");

  const approvals = await prisma.approvalRequest.findMany({ where: { agentTaskId: result.id } });
  assert.equal(approvals.length, 0, "confirma la premisa del bug real: la pantalla de Approvals no tiene nada que mostrar para esta tarea");
});

test("draft_outreach bloqueado por el gate (Company.origin=DEMO_SEED): el AgentTask termina DONE, nunca AWAITING_APPROVAL fantasma", async () => {
  const tenant = await setupTenantWithAgents("demo-seed", ["sales"]);

  const result = await runWithTenancyContext({ tenantId: tenant.id, userId: "test-user", permissions: [] }, async () => {
    const construction = await prisma.industry.findFirstOrThrow({ where: { name: "Construction", isGlobal: true } });
    const company = await prisma.company.create({
      data: {
        tenantId: tenant.id,
        name: "F29 DEMO_SEED test company",
        industryId: construction.id,
        state: "IL",
        origin: "DEMO_SEED",
      },
    });
    const lead = await prisma.lead.create({
      data: { tenantId: tenant.id, companyId: company.id, industryId: construction.id, source: "test", status: "NEW" },
    });

    return createAndRunTaskSync(tenant.id, "test-user", {
      agentKey: "sales",
      type: "draft_outreach",
      input: { leadId: lead.id, channel: "EMAIL" },
      triggeredBy: "AGENT",
    });
  });

  assert.equal(result.status, "DONE", "sin ApprovalRequest real (DEMO_SEED bloquea el gate), el AgentTask nunca debe quedar AWAITING_APPROVAL");
  const output = result.output as { draftBody: string | null; blockReason?: string | null };
  assert.equal(output.draftBody, null);
  assert.equal(output.blockReason, "DEMO_SEED");

  const approvals = await prisma.approvalRequest.findMany({ where: { agentTaskId: result.id } });
  assert.equal(approvals.length, 0);
});
