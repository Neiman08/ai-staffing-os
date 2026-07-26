import { randomUUID } from "node:crypto";
import type { InternalAcceptanceTestResult, RunInternalAcceptanceTestInput } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { logAuditEvent } from "../../core/audit-log";
import { isProductionMode } from "../../core/production-mode";
import { createAndRunTaskSync } from "../agents/task-executor";
import * as leadsService from "../leads/service";
import * as approvalsService from "../approvals/service";
import type { SendApprovalDeps } from "../approvals/service";

/**
 * F27 (Internal Acceptance Test) -- respuesta directa a una brecha
 * arquitectónica real encontrada en esta misión: no existía ninguna
 * forma oficial de probar Approve & Send de punta a punta sin hacer
 * pasar un contacto de prueba como una verificación comercial real
 * (Hunter/PDL/Website Intelligence). Este es el ÚNICO lugar del código
 * que:
 *
 *   1. Puede escribir Company.origin="INTERNAL_TEST".
 *   2. Puede escribir Contact.source="INTERNAL_TEST" +
 *      verificationStatus="INTERNAL_TEST_VERIFIED" (el marcador doble
 *      que contact-channel.ts exige para el canal INTERNAL_TEST_EMAIL --
 *      ver ese archivo).
 *
 * Ningún endpoint CRUD genérico (companies/contacts) expone estos
 * valores -- por diseño, para que esto nunca sea alcanzable desde fuera
 * de este único flujo gateado. La autorización real (admin, entorno,
 * destinatario) se verifica ACÁ, una sola vez, ANTES de escribir
 * cualquiera de los 2 marcadores -- por eso alcanza con que
 * evaluateDraftCreationGate/resolveBestContactChannel solo reconozcan el
 * marcador, sin repetir estos mismos chequeos más abajo en el pipeline
 * genérico de draftOutreach (que no tiene forma de recibir ese contexto
 * sin agregar un parámetro genérico que cualquiera podría pasar -- ver
 * requisito explícito de "no expongas un endpoint genérico capaz de
 * saltarse la verificación").
 *
 * Reutiliza el mismo Approve & Send real de producción (editApprovalDraft
 * -> decideApproval -> sendApproval) -- nunca llama a sendGraphMail ni a
 * Microsoft Graph directamente, nunca usa /emails/send-manual.
 */

export interface InternalAcceptanceTestDeps {
  // Inyección para tests -- nunca se llama a OpenAI real en un test
  // unitario/integración. Default: el pipeline real de draftOutreach
  // (createQueuedTask + ejecución síncrona real, mismo agentKey/type que
  // usa la UI vía POST /agents/sales/tasks).
  draftOutreachRunner?: (params: { leadId: string; tenantId: string; userId: string }) => Promise<{ approvalRequestId: string } | { failed: true; reason: string }>;
  // Pass-through directo a sendApproval -- mismo patrón de inyección que
  // el resto del repo, nunca se llama a Graph real en un test.
  sendApprovalDeps?: SendApprovalDeps;
}

function parseAllowlist(): Set<string> {
  return new Set(
    env.INTERNAL_ACCEPTANCE_TEST_ALLOWED_RECIPIENTS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * "El entorno no sea producción comercial abierta O exista una bandera
 * segura habilitada" -- PRODUCTION_MODE=false (el default de hoy) ya
 * alcanza; con PRODUCTION_MODE=true, hace falta además la bandera
 * explícita INTERNAL_ACCEPTANCE_TEST_ENABLED=true.
 */
function isEnvironmentSafeForAcceptanceTest(): boolean {
  return !isProductionMode() || env.INTERNAL_ACCEPTANCE_TEST_ENABLED;
}

async function realDraftOutreachRunner(params: { leadId: string; tenantId: string; userId: string }): Promise<{ approvalRequestId: string } | { failed: true; reason: string }> {
  // Mismo agentKey/type exacto que POST /agents/sales/tasks (ver
  // agents/service.ts's invokeSalesAgentTask) -- createAndRunTaskSync es
  // la variante síncrona que ya usa el orquestador del Prospecting Agent
  // para cada paso hijo, evita tener que hacer polling manual acá.
  const task = await createAndRunTaskSync(params.tenantId, params.userId, {
    agentKey: "sales",
    type: "draft_outreach",
    input: { leadId: params.leadId, channel: "EMAIL" },
    triggeredBy: "USER",
  });
  const approval = await scopedDb.approvalRequest.findFirst({ where: { agentTaskId: task.id }, orderBy: { createdAt: "desc" } });
  if (!approval) {
    return { failed: true, reason: task.errorMessage ?? `draftOutreach no produjo ningún ApprovalRequest (AgentTask ${task.id}, status=${task.status}).` };
  }
  return { approvalRequestId: approval.id };
}

export async function runInternalAcceptanceTest(input: RunInternalAcceptanceTestInput, deps: InternalAcceptanceTestDeps = {}): Promise<InternalAcceptanceTestResult> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const initiatedAt = new Date();
  // F27 (req. explícito: "registra... quién inició, que fue una prueba
  // interna, motivo, destinatario autorizado, cada transición de
  // estado"): un solo id real que correlaciona TODOS los AuditLog de esta
  // corrida, incluidos los que ocurren antes de que exista una Company.
  const testRunId = randomUUID();

  // ---------- 1) Autorización real, ANTES de crear absolutamente nada ----------
  if (!isEnvironmentSafeForAcceptanceTest()) {
    throw AppError.forbidden("Internal Acceptance Test deshabilitado: PRODUCTION_MODE=true sin INTERNAL_ACCEPTANCE_TEST_ENABLED=true.");
  }
  const allowlist = parseAllowlist();
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  if (!allowlist.has(recipientEmail)) {
    throw AppError.forbidden(`Destinatario "${input.recipientEmail}" no está en la allowlist de pruebas internas -- envío rechazado.`);
  }

  await logAuditEvent({
    action: "internal_test.initiated",
    entityType: "internalAcceptanceTest",
    entityId: testRunId,
    after: { testRunId, initiatedBy: ctx.userId, reason: input.reason, recipientEmail: input.recipientEmail, isInternalTest: true },
  });

  // ---------- 2) Company/Lead/Contact reales, marcados INTERNAL_TEST ----------
  const industry = await scopedDb.industry.findFirst({ select: { id: true } });
  if (!industry) throw AppError.internal("No hay ninguna Industry real en este tenant -- no se puede crear la Company de prueba.");

  const company = await scopedDb.company.create({
    data: { tenantId: ctx.tenantId, name: "DreiStaff — Internal Acceptance Test", industryId: industry.id, status: "LEAD", origin: "INTERNAL_TEST" },
  });

  const lead = await leadsService.createLead({ companyId: company.id, industryId: industry.id, source: "INTERNAL_TEST" });

  const contact = await scopedDb.contact.create({
    data: {
      tenantId: ctx.tenantId,
      companyId: company.id,
      firstName: "Internal",
      lastName: "Acceptance Test",
      email: input.recipientEmail,
      source: "INTERNAL_TEST",
      verificationStatus: "INTERNAL_TEST_VERIFIED",
      isPrimary: true,
    },
  });

  await logAuditEvent({
    action: "internal_test.entities_created",
    entityType: "internalAcceptanceTest",
    entityId: testRunId,
    after: { testRunId, companyId: company.id, leadId: lead.id, contactId: contact.id, isInternalTest: true },
  });

  // ---------- 3) Borrador real (IA), vía el mismo draftOutreach de producción ----------
  const draftOutreachRunner = deps.draftOutreachRunner ?? realDraftOutreachRunner;
  const draftResult = await draftOutreachRunner({ leadId: lead.id, tenantId: ctx.tenantId, userId: ctx.userId });
  if ("failed" in draftResult) {
    await logAuditEvent({
      action: "internal_test.draft_failed",
      entityType: "internalAcceptanceTest",
      entityId: testRunId,
      after: { testRunId, reason: draftResult.reason, isInternalTest: true },
    });
    throw AppError.internal(`Internal Acceptance Test: draftOutreach falló -- ${draftResult.reason}`);
  }
  const approvalRequestId = draftResult.approvalRequestId;

  await logAuditEvent({
    action: "internal_test.draft_created",
    entityType: "approvalRequest",
    entityId: approvalRequestId,
    after: { testRunId, companyId: company.id, isInternalTest: true },
  });

  // ---------- 4) Edición oficial del borrador -> asunto/cuerpo EXACTOS autorizados ----------
  await approvalsService.editApprovalDraft(approvalRequestId, {
    to: input.recipientEmail,
    subject: "DreiStaff – Final Production Acceptance Test",
    body: "This is an authorized final production acceptance test for DreiStaff. It is intended solely to verify the official approval, sending, Microsoft Graph, reconciliation, and audit workflow. No response is required.",
  });

  // ---------- 5) Approve & Send oficial de producción ----------
  const decided = await approvalsService.decideApproval(approvalRequestId, { decision: "APPROVED" });
  await logAuditEvent({
    action: "internal_test.approved",
    entityType: "approvalRequest",
    entityId: approvalRequestId,
    after: { testRunId, status: decided.status, isInternalTest: true },
  });

  const sent = await approvalsService.sendApproval(approvalRequestId, deps.sendApprovalDeps ?? {});
  await logAuditEvent({
    action: "internal_test.send_attempted",
    entityType: "approvalRequest",
    entityId: approvalRequestId,
    after: { testRunId, status: sent.status, emailSendResult: sent.emailSendResult, isInternalTest: true },
  });

  const emailMessage = await scopedDb.emailMessage.findFirst({ where: { approvalRequestId }, orderBy: { createdAt: "desc" } });

  const completedAt = new Date();
  await logAuditEvent({
    action: "internal_test.completed",
    entityType: "internalAcceptanceTest",
    entityId: testRunId,
    after: {
      testRunId,
      companyId: company.id,
      approvalRequestId,
      emailMessageId: emailMessage?.id ?? null,
      approvalStatus: sent.status,
      emailSendResultStatus: sent.emailSendResult?.status ?? null,
      isInternalTest: true,
    },
  });

  return {
    companyId: company.id,
    leadId: lead.id,
    contactId: contact.id,
    approvalRequestId,
    emailMessageId: emailMessage?.id ?? null,
    correlationId: emailMessage?.correlationId ?? null,
    approvalStatus: sent.status,
    emailSendResult: sent.emailSendResult
      ? {
          status: sent.emailSendResult.status,
          providerMessageId: sent.emailSendResult.providerMessageId,
          internetMessageId: sent.emailSendResult.internetMessageId ?? null,
          conversationId: sent.emailSendResult.conversationId ?? null,
          errorMessage: sent.emailSendResult.errorMessage,
        }
      : null,
    initiatedAt: initiatedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}
