import { z } from "zod";
import { agentSuccess, agentFailure, classifyError, buildEventEnvelope, buildIdempotencyKey, AgentError, type AgentExecutor, type AgentExecutionContext } from "@ai-staffing-os/agents";
import type { DecisionRolePlan } from "../../ceo-intelligence/role-planning";
import { enrichCompanyWithDecisionContacts, type ContactEnrichmentReport } from "../contact-enrichment";
import { createOrMergeHumanReviewRequest } from "../../human-review/service";

/**
 * F25.2 Fase 7 + activación controlada (Prioridad 4): mismo tratamiento
 * que Fase 6 (Discovery), aplicado a `enrichCompanyWithDecisionContacts`
 * (contact-enrichment.ts, ya real/producción/testeada). "No reescribas
 * la lógica" -- cero cambios a contact-enrichment.ts ni a
 * resolveBestContactChannel/contact-channel.ts (esa selección ya ocurre
 * DENTRO de la cascada real, este wrapper no la toca ni la duplica).
 *
 * Prioridad 4 (activación controlada) agrega, leyendo el reporte YA
 * producido (nunca reimplementando la cascada):
 * - publica contact.verified.v1 por cada contacto con emailDomainTrust
 *   real (CreatedContactRecord, ya existente);
 * - crea un HumanReviewRequest (CONTACT_AMBIGUOUS) cuando el plan pidió
 *   roles que NINGUNA fuente pudo resolver (rolesWithoutContact) -- el
 *   caso honesto de "no lo inventes, preguntale a un humano";
 * - marca DATA_INSUFFICIENT cuando había un rolePlan real (con roles
 *   objetivo) y no se creó NINGÚN contacto -- rolePlan=null (nunca se
 *   planificó nada) sigue siendo agentSuccess vacío, sin cambios.
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

        if (input.rolePlan !== null && report.contactsCreated.length === 0) {
          return agentFailure(
            new AgentError(
              "DATA_INSUFFICIENT",
              `Ningún contacto resoluble para ${input.companyName} pese a un rolePlan real (roles pedidos: ${input.rolePlan.targetRoles.map((r) => r.role).join(", ")}).`,
            ),
          );
        }

        const events = report.contactsCreated.flatMap((contact) => {
          const discovered = buildEventEnvelope({
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
          });
          if (!contact.emailDomainTrust) return [discovered];
          const verified = buildEventEnvelope({
            eventType: "contact.verified.v1",
            tenantId: context.tenantId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            actorType: "AGENT" as const,
            actorId: context.agentInstanceId,
            entityType: "contact",
            entityId: contact.contactId,
            payload: { contactId: contact.contactId, emailVerificationStatus: contact.emailDomainTrust },
            idempotencyKey: buildIdempotencyKey(context.correlationId, "contact.verified.v1", contact.contactId),
          });
          return [discovered, verified];
        });

        if (report.rolesWithoutContact.length > 0) {
          await createOrMergeHumanReviewRequest({
            type: "CONTACT_AMBIGUOUS",
            priority: "MEDIUM",
            entityType: "company",
            entityId: input.companyId,
            summary: `${input.companyName}: ${report.rolesWithoutContact.length} rol(es) sin contacto resoluble`,
            evidence: [{ rolesWithoutContact: report.rolesWithoutContact.join(", "), sourcesUsed: report.sourcesUsed.join(", ") || "ninguna" }],
            requestedDecision: "Decidir si buscar manualmente o continuar sin contacto para estos roles.",
            options: [
              { label: "Buscar manualmente", consequence: "Un humano investiga el contacto fuera del sistema." },
              { label: "Continuar sin este rol", consequence: "La misión avanza con los roles ya resueltos únicamente." },
            ],
            recommendation: null,
            impact: "Estos roles quedan sin contacto identificado hasta que se resuelva.",
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
