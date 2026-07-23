import { z } from "zod";
import { agentSuccess, agentFailure, classifyError, buildEventEnvelope, buildIdempotencyKey, AgentError, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import type { MissionRestrictions } from "@ai-staffing-os/agents";
import type { MissionPlan } from "../../ceo-intelligence/contracts";
import { executeDiscoveryPlan, type DiscoveryExecutionReport } from "../mission-executor";

/**
 * F25.2 Fase 6: envuelve `executeDiscoveryPlan` (mission-executor.ts,
 * ya real/producción/testeada) como un `AgentExecutor` que el
 * Orchestrator (Fase 4) puede reclamar y ejecutar. "No reescribas la
 * lógica" -- este archivo NO reimplementa ni un paso del pipeline de
 * discovery; solo adapta la forma de entrada/salida al contrato
 * AgentExecutor y publica `company.discovered.v1` (catálogo de
 * eventos F25) por cada Company creada.
 *
 * El input NO se valida campo a campo con Zod -- `MissionPlan` y
 * `MissionRestrictions` ya se validan/construyen en
 * ceo-intelligence/mission-planning.ts antes de llegar acá (una
 * segunda validación acá sería una segunda fuente de verdad sobre la
 * misma forma, justo lo que ADR-0005 pide evitar). El schema solo
 * confirma la forma mínima que este wrapper necesita para no reventar
 * con un `undefined`.
 */
export const discoveryTaskInputSchema = z
  .object({
    missionTaskId: z.string().min(1),
    plan: z.custom<MissionPlan>((v) => typeof v === "object" && v !== null),
    restrictions: z.custom<MissionRestrictions>((v) => typeof v === "object" && v !== null),
    businessActivities: z.array(z.string()).optional(),
    targetJobTitles: z.array(z.string()).optional(),
    decisionRoles: z.array(z.string()).optional(),
  })
  .passthrough();

export type DiscoveryTaskInput = z.infer<typeof discoveryTaskInputSchema>;

export function createDiscoveryExecutor(): AgentExecutor<DiscoveryTaskInput, DiscoveryExecutionReport> {
  return {
    taskType: "discover_companies",
    stage: "DISCOVERY",
    inputSchema: discoveryTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: DiscoveryTaskInput) => {
      try {
        const report = await executeDiscoveryPlan({
          missionTaskId: input.missionTaskId,
          plan: input.plan,
          restrictions: input.restrictions,
          businessActivities: input.businessActivities,
          targetJobTitles: input.targetJobTitles,
          decisionRoles: input.decisionRoles,
        });

        const events = report.createdCompanyIds.map((companyId) =>
          buildEventEnvelope({
            eventType: "company.discovered.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "company",
            entityId: companyId,
            payload: { companyId },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "company.discovered.v1", companyId),
          }),
        );

        return agentSuccess(report, events);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}
