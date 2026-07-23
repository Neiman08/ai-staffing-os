import { z } from "zod";
import { findKnownPlaceholders } from "@ai-staffing-os/shared";
import { agentSuccess, buildEventEnvelope, buildIdempotencyKey, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import { evaluateDraftCreationGate } from "../../ceo-intelligence/draft-creation-gate";
import { evaluateApprovalQualityGate, type ApprovalQualityGateResult } from "../../ceo-intelligence/approval-quality-gate";
import { resolveBestContactChannel } from "../../ceo-intelligence/contact-channel";

/**
 * F25.2 Fase 8: Quality Agent -- "no dupliques lógica". Ninguna de las
 * 4 funciones de F24 se reimplementa acá. Este módulo es exclusivamente:
 *
 * (1) `QUALITY_AGENT_CAPABILITIES` -- re-export documentado de las 4
 *     funciones como "capacidades" del Quality Agent, sin envolver
 *     ninguna lógica nueva alrededor.
 * (2) `createQualityAgentExecutor` -- UN AgentExecutor real para
 *     `evaluateApprovalQualityGate`, la única de las 4 que corresponde
 *     a un paso DISCRETO del pipeline (QUALITY_REVIEW, justo antes de
 *     la aprobación humana) y por eso tiene sentido como AgentTask
 *     propio. Las otras tres ya se invocan inline en sus puntos reales
 *     (draft-creation-gate.ts en los 3 call sites de F24,
 *     resolveBestContactChannel al resolver el destinatario,
 *     findKnownPlaceholders DENTRO de evaluateApprovalQualityGate --
 *     confirmado leyendo approval-quality-gate.ts, ya lo usa) --
 *     envolverlas como AgentExecutor separados crearía un AgentTask
 *     que nadie dispara todavía, trabajo muerto.
 */
export const QUALITY_AGENT_CAPABILITIES = {
  evaluateDraftCreationGate,
  evaluateApprovalQualityGate,
  resolveBestContactChannel,
  findKnownPlaceholders,
} as const;

export const qualityTaskInputSchema = z.object({
  approvalRequestId: z.string().min(1),
  companyOrigin: z.string().nullable(),
  companyCommercialStatus: z.string().nullable(),
  to: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  hasOtherActiveDuplicateApproval: z.boolean(),
});

export type QualityTaskInput = z.infer<typeof qualityTaskInputSchema>;

export function createQualityAgentExecutor(): AgentExecutor<QualityTaskInput, ApprovalQualityGateResult> {
  return {
    taskType: "evaluate_draft_quality",
    stage: "QUALITY_REVIEW",
    inputSchema: qualityTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: QualityTaskInput) => {
      // Función pura y síncrona (F24, sin modificar) -- llamarla directo
      // es exactamente "no dupliques lógica", nunca reimplementar los 8
      // checks acá.
      const result = evaluateApprovalQualityGate(input);

      const event = buildEventEnvelope({
        eventType: "outreach.quality_passed.v1",
        tenantId: context.tenantId,
        correlationId: context.correlationId,
        causationId: context.causationId,
        actorType: "AGENT",
        actorId: context.agentInstanceId,
        entityType: "approval_request",
        entityId: input.approvalRequestId,
        // verdict simplificado a PASS/NEEDS_REVISION -- evaluateApprovalQualityGate
        // hoy solo distingue passed:boolean, no la taxonomía completa de 5
        // valores del catálogo (NEEDS_ENRICHMENT/HUMAN_REVIEW/BLOCKED son
        // distinciones que esa función no hace todavía -- no se inventan acá).
        payload: {
          approvalRequestId: input.approvalRequestId,
          verdict: result.passed ? "PASS" : "NEEDS_REVISION",
          failedChecks: result.failures.map((f) => f.check),
        },
        idempotencyKey: buildIdempotencyKey(context.correlationId, "outreach.quality_passed.v1", input.approvalRequestId),
      });

      return agentSuccess(result, [event]);
    },
  };
}
