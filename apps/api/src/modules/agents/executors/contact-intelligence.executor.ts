import { z } from "zod";
import { agentSuccess, agentFailure, classifyError, buildEventEnvelope, buildIdempotencyKey, AgentError, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import type { DecisionRolePlan } from "../../ceo-intelligence/role-planning";
import { enrichCompanyWithDecisionContacts, type ContactEnrichmentReport } from "../contact-enrichment";

/**
 * F25.2 Fase 7: mismo tratamiento que Fase 6 (Discovery), aplicado a
 * `enrichCompanyWithDecisionContacts` (contact-enrichment.ts, ya real/
 * producción/testeada). "No reescribas la lógica" -- cero cambios a
 * contact-enrichment.ts ni a resolveBestContactChannel/contact-channel.ts
 * (esa selección ya ocurre DENTRO de la cascada real, este wrapper no
 * la toca ni la duplica).
 */
export const contactIntelligenceTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    companyId: z.string().min(1),
    companyName: z.string().min(1),
    companyWebsite: z.string().nullable(),
    companyState: z.string().nullable(),
    companyCity: z.string().nullable(),
    industryName: z.string().min(1),
    rolePlan: z.custom<DecisionRolePlan>((v) => v === null || typeof v === "object").nullable(),
  })
  .passthrough();

export type ContactIntelligenceTaskInput = z.infer<typeof contactIntelligenceTaskInputSchema>;

export function createContactIntelligenceExecutor(): AgentExecutor<ContactIntelligenceTaskInput, ContactEnrichmentReport> {
  return {
    taskType: "find_contacts",
    stage: "CONTACT_INTELLIGENCE",
    inputSchema: contactIntelligenceTaskInputSchema,
    execute: async (context: AgentExecutionContext, input: ContactIntelligenceTaskInput) => {
      try {
        const report = await enrichCompanyWithDecisionContacts({
          taskId: input.taskId,
          companyId: input.companyId,
          companyName: input.companyName,
          companyWebsite: input.companyWebsite,
          companyState: input.companyState,
          companyCity: input.companyCity,
          industryName: input.industryName,
          rolePlan: input.rolePlan,
        });

        const events = report.contactsCreated.map((contact) =>
          buildEventEnvelope({
            eventType: "contact.discovered.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "contact",
            entityId: contact.contactId,
            payload: { contactId: contact.contactId, companyId: input.companyId, matchedRole: contact.matchedRole },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "contact.discovered.v1", contact.contactId),
          }),
        );

        return agentSuccess(report, events);
      } catch (err) {
        return agentFailure(new AgentError(classifyError(err), err instanceof Error ? err.message : String(err), err));
      }
    },
  };
}
