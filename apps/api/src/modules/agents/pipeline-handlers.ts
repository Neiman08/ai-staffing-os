import { Prisma, type DomainEvent } from "@ai-staffing-os/db";
import { buildIdempotencyKey } from "@ai-staffing-os/agents";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { logger } from "../../core/logger";
import { PIPELINE_FLAGS, type PipelineFlags } from "../../core/pipeline-flags";
import { resolveAgentInstance } from "./task-executor";
import { resumeTaskAfterHumanReview } from "./task-lifecycle";
import { getTaxonomyEntry } from "../ceo-intelligence/taxonomy";
import { buildDecisionRolePlan } from "../ceo-intelligence/role-planning";
import { hasOtherActiveApprovalForCompany } from "../approvals/service";
import type { EventDispatcher } from "../../core/events/dispatcher";

/**
 * F25.2 (activación controlada, Prioridad 3): handlers reales del
 * EventDispatcher -- cada uno idempotente (idempotencyKey determinístico
 * del mismo patrón usado en toda la sesión: create -> catch P2002 ->
 * no-op), multi-tenant (siempre corre dentro de runWithTenancyContext
 * con el tenantId del evento, nunca asume un tenant fijo), trazable
 * (correlationId/causationId propagados) y reintentable (una falla acá
 * hace que EventDispatcher.runOnce marque el evento failed -- replay
 * seguro, ver outbox.ts). "No agregues handlers vacíos": solo se
 * registran los que hacen algo real -- contact.verified.v1 no tiene un
 * handler propio porque no hay ninguna acción real que disparar todavía
 * más allá de lo que ya hace contact.discovered.v1 (mismo evento
 * source, ver contact-intelligence.executor.ts).
 */

function eventTenantContext(event: DomainEvent) {
  return { tenantId: event.tenantId, userId: "system-pipeline-handler", permissions: [] as string[] };
}

/**
 * company.discovered.v1 -> crea find_contacts (gateado por
 * contactIntelligenceAgentEnabled). Sin taxonomyKey real, no se
 * inventa un rolePlan -- se omite en silencio (no es un error, es una
 * Company sin evidencia suficiente para planificar roles).
 */
async function handleCompanyDiscovered(event: DomainEvent, flags: PipelineFlags): Promise<void> {
  if (!flags.contactIntelligenceAgentEnabled) return;
  const payload = event.payload as { companyId?: string };
  if (!payload.companyId) return;

  await runWithTenancyContext(eventTenantContext(event), async () => {
    const company = await scopedDb.company.findUnique({ where: { id: payload.companyId! }, include: { industry: true } });
    if (!company) return;

    const meta = (company.discoveryMetadata ?? {}) as { queryOrigins?: string[] };
    const taxonomyKey = meta.queryOrigins?.[0];
    if (!taxonomyKey) return;
    const taxonomyEntry = getTaxonomyEntry(taxonomyKey);

    const rolePlan = buildDecisionRolePlan({
      companyId: company.id,
      taxonomyKey,
      intentDecisionRoles: [],
      taxonomyDecisionMakers: taxonomyEntry?.decisionMakers ?? [],
      hiringStatus: null,
      missionExclusions: [],
    });

    const agentInstance = await resolveAgentInstance("contact_intelligence");
    const idempotencyKey = buildIdempotencyKey(event.correlationId ?? company.id, "find_contacts", company.id);

    let task;
    try {
      task = await scopedDb.agentTask.create({
        data: {
          tenantId: event.tenantId,
          agentInstanceId: agentInstance.id,
          type: "find_contacts",
          status: "QUEUED",
          triggeredBy: "EVENT",
          correlationId: event.correlationId,
          causationId: event.id,
          idempotencyKey,
          input: {
            taskId: "",
            companyId: company.id,
            companyName: company.name,
            companyWebsite: company.website,
            companyState: company.state,
            companyCity: company.city,
            industryName: company.industry.name,
            rolePlan,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        logger.info("pipeline_handler_idempotent_skip", { handler: "company.discovered.v1", companyId: company.id });
        return;
      }
      throw err;
    }

    await scopedDb.agentTask.update({
      where: { id: task.id },
      data: { input: { ...(task.input as object), taskId: task.id } as Prisma.InputJsonValue },
    });
    logger.info("pipeline_handler_created_task", { handler: "company.discovered.v1", taskId: task.id, companyId: company.id });
  });
}

/**
 * outreach.draft_created.v1 -> crea evaluate_draft_quality (gateado por
 * qualityAgentEnabled). La timeline ya se reconstruye automáticamente
 * (Fase 9, agrupando por correlationId) -- "registrar timeline" no
 * necesita ninguna acción adicional acá.
 */
async function handleOutreachDraftCreated(event: DomainEvent, flags: PipelineFlags): Promise<void> {
  if (!flags.qualityAgentEnabled) return;
  const payload = event.payload as { approvalRequestId?: string };
  if (!payload.approvalRequestId) return;

  await runWithTenancyContext(eventTenantContext(event), async () => {
    const approval = await scopedDb.approvalRequest.findUnique({ where: { id: payload.approvalRequestId! }, include: { company: true } });
    if (!approval) return;

    const proposedAction = approval.proposedAction as { to?: string; subject?: string; body?: string };
    const hasOtherActive = approval.companyId ? await hasOtherActiveApprovalForCompany(approval.companyId, approval.id) : false;

    const agentInstance = await resolveAgentInstance("quality");
    const idempotencyKey = buildIdempotencyKey(event.correlationId ?? approval.id, "evaluate_draft_quality", approval.id);

    try {
      await scopedDb.agentTask.create({
        data: {
          tenantId: event.tenantId,
          agentInstanceId: agentInstance.id,
          type: "evaluate_draft_quality",
          status: "QUEUED",
          triggeredBy: "EVENT",
          correlationId: event.correlationId,
          causationId: event.id,
          idempotencyKey,
          input: {
            approvalRequestId: approval.id,
            companyOrigin: approval.company?.origin ?? null,
            companyCommercialStatus: approval.company?.commercialStatus ?? null,
            to: proposedAction.to ?? null,
            subject: proposedAction.subject ?? null,
            body: proposedAction.body ?? null,
            hasOtherActiveDuplicateApproval: hasOtherActive,
          } as Prisma.InputJsonValue,
        },
      });
      logger.info("pipeline_handler_created_task", { handler: "outreach.draft_created.v1", approvalRequestId: approval.id });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        logger.info("pipeline_handler_idempotent_skip", { handler: "outreach.draft_created.v1", approvalRequestId: approval.id });
        return;
      }
      throw err;
    }
  });
}

/**
 * human.review_resolved.v1 -> reanuda la AgentTask relacionada cuando
 * entityType="agent_task" (única forma real hoy en que una AgentTask
 * llega a HUMAN_REVIEW: recordTaskFailure clasificando
 * HUMAN_ACTION_REQUIRED, ver task-lifecycle.ts). Los HumanReviewRequest
 * que Discovery/Contact Intelligence crean hoy (Prioridad 2/4) apuntan
 * a entityType="company", no a una AgentTask -- esas tareas ya
 * terminaron exitosamente (agentSuccess), no hay nada que "reanudar"
 * en ese caso, así que este handler correctamente no hace nada para
 * ellos. Infraestructura real, lista para cuando un AgentExecutor
 * futuro clasifique HUMAN_ACTION_REQUIRED de verdad.
 */
async function handleHumanReviewResolved(event: DomainEvent): Promise<void> {
  const payload = event.payload as { entityType?: string; entityId?: string; resolution?: string };
  if (payload.entityType !== "agent_task" || !payload.entityId) return;

  await runWithTenancyContext(eventTenantContext(event), async () => {
    try {
      await resumeTaskAfterHumanReview(payload.entityId!, payload.resolution ?? "");
    } catch (err) {
      // AGENT_TASK_NOT_IN_HUMAN_REVIEW -- ya se resolvió por otro
      // camino, o el evento se redisparó (replay) después de ya
      // procesado una vez. No es un error real, es idempotencia.
      logger.info("pipeline_handler_resume_skip", { taskId: payload.entityId, message: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function registerPipelineHandlers(dispatcher: EventDispatcher, flags: PipelineFlags = PIPELINE_FLAGS): void {
  dispatcher.registerHandler("company.discovered.v1", (event) => handleCompanyDiscovered(event, flags));
  dispatcher.registerHandler("outreach.draft_created.v1", (event) => handleOutreachDraftCreated(event, flags));
  dispatcher.registerHandler("human.review_resolved.v1", handleHumanReviewResolved);
}
