import { z } from "zod";
import { findKnownPlaceholders } from "@ai-staffing-os/shared";
import { agentSuccess, agentFailure, buildEventEnvelope, buildIdempotencyKey, AgentError, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import { evaluateDraftCreationGate } from "../../ceo-intelligence/draft-creation-gate";
import { evaluateApprovalQualityGate, type ApprovalQualityGateResult, type ApprovalQualityCheckFailure } from "../../ceo-intelligence/approval-quality-gate";
import { resolveBestContactChannel } from "../../ceo-intelligence/contact-channel";
import { publishEventSafe } from "../../../core/events/outbox";
import { createOrMergeHumanReviewRequest } from "../../human-review/service";

/**
 * F25.2 Fase 8 + activación controlada (Prioridad 5): Quality Agent --
 * "no dupliques lógica". Ninguna de las 4 funciones de F24 se
 * reimplementa acá. Este módulo es exclusivamente:
 *
 * (1) `QUALITY_AGENT_CAPABILITIES` -- re-export documentado de las 4
 *     funciones como "capacidades" del Quality Agent, sin envolver
 *     ninguna lógica nueva alrededor.
 * (2) `createQualityAgentExecutor` -- UN AgentExecutor real para
 *     `evaluateApprovalQualityGate`, la única de las 4 que corresponde
 *     a un paso DISCRETO del pipeline (QUALITY_REVIEW, justo antes de
 *     la aprobación humana).
 *
 * Prioridad 5 agrega la taxonomía completa de 5 verdicts (el gate real
 * solo devuelve passed:boolean + failures[] -- este mapeo es NUEVO,
 * declarado acá, nunca inventa una distinción que evaluateApprovalQualityGate
 * no haga):
 * - PASS: sin failures.
 * - HUMAN_REVIEW: no_duplicates -- una condición de carrera real entre
 *   dos ApprovalRequest para la misma Company amerita que un humano
 *   decida, no un texto que se pueda simplemente reescribir.
 * - BLOCKED: company_valid/classification_valid/minimal_metadata --
 *   datos estructurales (DEMO_SEED, sin validar, sin Company
 *   resoluble) que ninguna edición del borrador puede arreglar.
 * - NEEDS_ENRICHMENT: contact_valid/email_valid -- falta un canal de
 *   contacto válido, necesita más enriquecimiento, no una revisión de
 *   texto.
 * - NEEDS_REVISION: no_placeholders/content_complete -- se arregla
 *   editando el borrador (ver Approvals.tsx, "Editar borrador").
 *
 * El evento outreach.quality_passed.v1 se publica SIEMPRE (incluso
 * cuando el resultado de la tarea es agentFailure para BLOCKED/
 * HUMAN_REVIEW) -- vía publishEventSafe directo, no solo a través de
 * AgentResult.events (que el Orchestrator únicamente publica en el
 * camino de éxito). Perder el evento de un verdict negativo sería
 * perder observabilidad justo en el caso que más importa.
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

export type QualityVerdict = "PASS" | "NEEDS_REVISION" | "NEEDS_ENRICHMENT" | "HUMAN_REVIEW" | "BLOCKED";

const STRUCTURAL_BLOCK_CHECKS = new Set(["company_valid", "classification_valid", "minimal_metadata"]);
const ENRICHMENT_CHECKS = new Set(["contact_valid", "email_valid"]);

export function deriveQualityVerdict(failures: ApprovalQualityCheckFailure[]): QualityVerdict {
  if (failures.length === 0) return "PASS";
  const checks = new Set(failures.map((f) => f.check));
  if (checks.has("no_duplicates")) return "HUMAN_REVIEW";
  if ([...checks].some((c) => STRUCTURAL_BLOCK_CHECKS.has(c))) return "BLOCKED";
  if ([...checks].some((c) => ENRICHMENT_CHECKS.has(c))) return "NEEDS_ENRICHMENT";
  return "NEEDS_REVISION";
}

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
      const verdict = deriveQualityVerdict(result.failures);

      await publishEventSafe(
        buildEventEnvelope({
          eventType: "outreach.quality_passed.v1",
          tenantId: context.tenantId,
          correlationId: context.correlationId,
          causationId: context.causationId,
          actorType: "AGENT",
          actorId: context.agentInstanceId,
          entityType: "approval_request",
          entityId: input.approvalRequestId,
          payload: { approvalRequestId: input.approvalRequestId, verdict, failedChecks: result.failures.map((f) => f.check) },
          idempotencyKey: buildIdempotencyKey(context.correlationId, "outreach.quality_passed.v1", input.approvalRequestId),
        }),
      );

      if (verdict === "HUMAN_REVIEW") {
        await createOrMergeHumanReviewRequest({
          type: "POLICY_EXCEPTION",
          priority: "HIGH",
          entityType: "approval_request",
          entityId: input.approvalRequestId,
          summary: `ApprovalRequest ${input.approvalRequestId}: posible duplicado activo para la misma Company`,
          evidence: result.failures.map((f) => ({ check: f.check, reason: f.reason })),
          requestedDecision: "Decidir cuál de los borradores activos para esta Company debe continuar.",
          options: [
            { label: "Mantener este borrador", consequence: "El otro ApprovalRequest activo debe rechazarse manualmente." },
            { label: "Rechazar este borrador", consequence: "El ApprovalRequest original sigue su curso normal." },
          ],
          recommendation: null,
          impact: "Ninguno de los dos borradores se aprueba hasta decidir.",
          correlationId: context.correlationId,
        });
        return agentFailure(new AgentError("HUMAN_ACTION_REQUIRED", `Verdict HUMAN_REVIEW: ${result.failures.map((f) => f.reason).join("; ")}`));
      }

      if (verdict === "BLOCKED") {
        return agentFailure(new AgentError("POLICY_BLOCKED", `Verdict BLOCKED: ${result.failures.map((f) => f.reason).join("; ")}`));
      }

      // PASS/NEEDS_REVISION/NEEDS_ENRICHMENT: la tarea se completa
      // normalmente -- el ApprovalRequest queda en su estado actual
      // (PENDING), la decisión de aprobar sigue siendo 100% humana (ver
      // Approvals.tsx). Este executor NUNCA aprueba ni envía nada.
      return agentSuccess(result, []);
    },
  };
}
