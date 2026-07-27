import { z } from "zod";
import { agentSuccess, agentFailure, classifyError, buildEventEnvelope, buildIdempotencyKey, AgentError, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import type { MissionRestrictions } from "@ai-staffing-os/agents";
import type { MissionPlan } from "../../ceo-intelligence/contracts";
import { executeDiscoveryPlan, type DiscoveryExecutionReport } from "../mission-executor";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { createOrMergeHumanReviewRequest } from "../../human-review/service";

/**
 * F25.2 Fase 6 + activación controlada (Prioridad 2): envuelve
 * `executeDiscoveryPlan` (mission-executor.ts, ya real/producción/
 * testeada) como un `AgentExecutor` que el Orchestrator (Fase 4) puede
 * reclamar y ejecutar. "No reescribas la lógica" -- este archivo NO
 * reimplementa ni un paso del pipeline de discovery; solo adapta la
 * forma de entrada/salida al contrato AgentExecutor y publica
 * `company.discovered.v1` por cada Company creada.
 *
 * DEMO_SEED bloqueado / business identity gate / isClientOwnerCandidate
 * ya se enforcean DENTRO de executeDiscoveryPlan/persistAcceptedCandidate
 * (F16/F18/F19, sin modificar) -- discovery nunca crea una Company
 * DEMO_SEED (ese origin solo lo produce el seed real), y la clasificación
 * de negocio/identidad ya corre antes de persistir. Esta Prioridad 2
 * agrega, leyendo la Company YA creada (nunca reimplementando su
 * clasificación): un HumanReviewRequest real cuando
 * `isClientOwnerCandidate=true` -- señal ya calculada por
 * critical-infrastructure-clients.ts, ver mission-executor.ts -- para
 * que un humano decida si prospectar igual a una empresa que podría ser
 * cliente actual, en vez de solo bloquear outreach en silencio.
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

        const createdCompanies =
          report.createdCompanyIds.length > 0
            ? await scopedDb.company.findMany({ where: { id: { in: report.createdCompanyIds } } })
            : [];

        const events = createdCompanies.map((company) => {
          const meta = (company.discoveryMetadata ?? {}) as { classificationMode?: string; isClientOwnerCandidate?: boolean; clientOwnerAssociations?: string[] };
          return buildEventEnvelope({
            eventType: "company.discovered.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "company",
            entityId: company.id,
            payload: { companyId: company.id, origin: company.origin, businessConfidence: meta.classificationMode ?? null, sourceUrl: company.sourceUrl },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "company.discovered.v1", company.id),
          });
        });

        for (const company of createdCompanies) {
          const meta = (company.discoveryMetadata ?? {}) as { isClientOwnerCandidate?: boolean; clientOwnerAssociations?: string[] };
          if (!meta.isClientOwnerCandidate) continue;
          await createOrMergeHumanReviewRequest({
            type: "POLICY_EXCEPTION",
            priority: "HIGH",
            entityType: "company",
            entityId: company.id,
            summary: `${company.name}: posible cliente actual (${(meta.clientOwnerAssociations ?? []).join(", ") || "asociación detectada"})`,
            evidence: [{ clientOwnerAssociations: (meta.clientOwnerAssociations ?? []).join(", ") }],
            requestedDecision: "Autorizar o bloquear la prospección de esta empresa.",
            options: [
              { label: "Autorizar prospección", consequence: "La empresa continúa el pipeline normalmente." },
              { label: "Bloquear", consequence: "La empresa queda excluida de outreach automático." },
            ],
            recommendation: null,
            impact: "Sin decisión, la empresa queda bloqueada para outreach automático por defecto (ver draft-creation-gate.ts).",
            correlationId: context.correlationId,
          });
        }

        return agentSuccess(report, events);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}
