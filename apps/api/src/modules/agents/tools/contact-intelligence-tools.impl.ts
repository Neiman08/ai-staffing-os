import { z } from "zod";
import {
  findContactsTool as findContactsToolStub,
  findContactsInputSchema,
  findEmailTool as findEmailToolStub,
  findEmailInputSchema,
  type AgentTool,
  type DiscoveredContact,
  type DiscoveredField,
  type EmailUpdatedContact,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import { env } from "../../../core/env";
import type { UsageAccumulator } from "../usage";
import { getDataProviderBudgetStatus } from "../data-provider-budget";
import { searchPeopleDataLabs } from "./contact-providers/people-data-labs";
import { runWebsiteIntelligence } from "./website-intelligence/crawler";
import type { WebsiteIntelligenceResult, WebsiteNamedPerson } from "./website-intelligence/types";
import { searchHunterEmails } from "./email-providers/hunter";
import type { EmailCandidate } from "./email-providers/types";
import { verifyEmailWithHunter } from "./email-verification-providers/hunter";
import { unknownVerificationResult } from "./email-verification-providers/types";

/**
 * F4.6: Contact Intelligence Agent — orquesta proveedores de contactos.
 * Corre DESPUÉS de Discovery y ANTES de Outreach (ver mission-orchestrator.ts):
 * por cada Company nueva, busca personas de decisión reales, nunca
 * inventa un dato, y nunca envía nada — solo enriquece el CRM. Mismo
 * patrón exacto que discovery-tools.impl.ts (proveedor primario
 * configurable por env, contrato compartido en contact-providers/).
 */

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[contacts] ${event}`, JSON.stringify({ taskId, ...data }));
}

// F4.6 §"Priorizar estos cargos" — orden literal del pedido; se usan
// tanto para la búsqueda en el proveedor como para categorizar
// decisionRole a partir del title real (nunca al revés: el title real
// siempre manda, esto solo clasifica).
const PRIORITY_TITLES = [
  "HR Manager",
  "Talent Acquisition",
  "Recruiter",
  "Operations Manager",
  "Plant Manager",
  "Warehouse Manager",
  "General Manager",
  "Purchasing Manager",
  "Director of Operations",
  "Owner",
];

const TITLE_TO_DECISION_ROLE: Array<{ keywords: string[]; role: string }> = [
  { keywords: ["talent acquisition"], role: "TALENT_ACQUISITION" },
  { keywords: ["hr", "human resources"], role: "HR" },
  { keywords: ["recruit"], role: "RECRUITER" },
  { keywords: ["warehouse manager"], role: "WAREHOUSE_MANAGER" },
  { keywords: ["plant manager"], role: "PLANT_MANAGER" },
  { keywords: ["director of operations"], role: "DIRECTOR_OF_OPERATIONS" },
  { keywords: ["operations manager", "operations director"], role: "OPERATIONS_MANAGER" },
  { keywords: ["general manager"], role: "GENERAL_MANAGER" },
  { keywords: ["purchasing", "procurement"], role: "PURCHASING_MANAGER" },
  { keywords: ["owner", "founder", "president", "ceo"], role: "OWNER" },
];

/** Categoriza un title real contra los cargos prioritarios — nunca inventa, solo clasifica lo que ya vino literal. */
export function mapTitleToDecisionRole(title: string | null): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const { keywords, role } of TITLE_TO_DECISION_ROLE) {
    if (keywords.some((k) => lower.includes(k))) return role;
  }
  return null;
}

/** Score determinista (nunca lo decide el LLM) — mismo espíritu que discovery-tools.impl.ts. */
export function computeContactConfidenceScore(fields: Record<string, DiscoveredField>): number {
  let score = 0.5; // nombre + empresa confirmados (si no, ni se llega a evaluar el candidato)
  if (fields.title?.status === "CONFIRMED") score += 0.1;
  if (fields.linkedinUrl?.status === "CONFIRMED") score += 0.2;
  if (fields.email?.status === "CONFIRMED") score += 0.15;
  if (fields.phone?.status === "CONFIRMED") score += 0.05;
  return Math.min(1, score);
}

/** F4.7: dominio sin protocolo/www, para el contrato de email-providers (domain search). */
function deriveDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Match conservador (exacto, case-insensitive) — un match dudoso es peor que NOT_FOUND. */
function namesMatch(a: { firstName: string; lastName: string }, b: { firstName: string; lastName: string }): boolean {
  return (
    a.firstName.trim().toLowerCase() === b.firstName.trim().toLowerCase() &&
    a.lastName.trim().toLowerCase() === b.lastName.trim().toLowerCase()
  );
}

async function auditAgentAction(params: {
  agentInstanceId: string;
  action: string;
  entityType: string;
  entityId: string;
  after?: unknown;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "AGENT",
      actorId: params.agentInstanceId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      after: params.after as never,
    },
  });
}

export interface ContactIntelligenceToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
  abortSignal?: AbortSignal;
}

export function createContactIntelligenceTools(deps: ContactIntelligenceToolDeps): AgentTool[] {
  return [
    {
      ...findContactsToolStub,
      async execute(input: z.infer<typeof findContactsInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const company = await scopedDb.company.findUnique({ where: { id: input.companyId }, include: { industry: true } });
        if (!company) throw AppError.notFound("Company not found");

        log(deps.taskId, "contact intelligence started", { companyId: company.id, companyName: company.name });

        const limit = Math.min(input.limit ?? 5, 10);

        const contactsCreated: DiscoveredContact[] = [];
        const sourcesUsed = new Set<string>();
        const patternsFailed: string[] = [];
        let candidatesFound = 0;
        let duplicatesSkipped = 0;
        let insufficientDataSkipped = 0;
        let irrelevantTitleSkipped = 0;
        let cancelled = false;

        // Solo People Data Labs hoy — un proveedor nuevo (Apollo/Proxycurl/
        // Clay) se agrega en contact-providers/ y se enchufa acá, el agente
        // nunca sabe cuál está usando (ver contact-providers/README.md).
        if (env.PEOPLEDATALABS_API_KEY) {
          const budgetStatus = await getDataProviderBudgetStatus(ctx.tenantId);
          if (budgetStatus.exceeded) {
            log(deps.taskId, "data provider budget exceeded, skipping contact search", { ...budgetStatus });
            patternsFailed.push(`presupuesto de proveedor de datos excedido ($${budgetStatus.spentUsd.toFixed(2)}/$${budgetStatus.budgetUsd.toFixed(2)})`);
          } else {
            const result = await searchPeopleDataLabs(
              {
                taskId: deps.taskId,
                companyName: company.name,
                companyWebsite: company.website,
                companyState: company.state,
                companyCity: company.city,
                industryName: company.industry.name,
                priorityTitles: PRIORITY_TITLES,
                limit,
                abortSignal: deps.abortSignal,
              },
              env.PEOPLEDATALABS_API_KEY,
            );
            if (result.costUsd > 0) deps.usage.recordExternalCost(result.costUsd);
            if (result.cancelled) {
              cancelled = true;
            } else {
              patternsFailed.push(...result.patternsFailed);
              for (const s of result.sourcesUsed) sourcesUsed.add(s);

              for (const candidate of result.candidates) {
                if (contactsCreated.length >= limit) break;
                candidatesFound++;

                if (!candidate.firstName || !candidate.lastName) {
                  insufficientDataSkipped++;
                  continue;
                }

                // PDL no filtra por cargo en el request (ver people-data-labs.ts)
                // — se pide un batch más grande y se descarta client-side todo
                // cargo que no mapee a un rol de decisión prioritario para
                // ventas de staffing (ej. "accounts receivable associate").
                if (mapTitleToDecisionRole(candidate.title) === null) {
                  irrelevantTitleSkipped++;
                  continue;
                }

                const email = candidate.fields.email?.status === "CONFIRMED" ? (candidate.fields.email.value as string) : null;
                const linkedinUrl = candidate.fields.linkedinUrl?.status === "CONFIRMED" ? (candidate.fields.linkedinUrl.value as string) : null;

                // Deduplicación: email, LinkedIn, o nombre+empresa — lo
                // que primero matchee descarta el candidato.
                const existing = await scopedDb.contact.findFirst({
                  where: {
                    companyId: company.id,
                    OR: [
                      ...(email ? [{ email }] : []),
                      ...(linkedinUrl ? [{ linkedinUrl }] : []),
                      { firstName: { equals: candidate.firstName, mode: "insensitive" as const }, lastName: { equals: candidate.lastName, mode: "insensitive" as const } },
                    ],
                  },
                });
                if (existing) {
                  duplicatesSkipped++;
                  log(deps.taskId, "duplicates discarded", { firstName: candidate.firstName, lastName: candidate.lastName, existingContactId: existing.id });
                  continue;
                }

                const confidenceScore = computeContactConfidenceScore(candidate.fields);
                const phone = candidate.fields.phone?.status === "CONFIRMED" ? (candidate.fields.phone.value as string) : null;
                const decisionRole = mapTitleToDecisionRole(candidate.title);

                const contact = await scopedDb.contact.create({
                  data: {
                    tenantId: ctx.tenantId,
                    companyId: company.id,
                    firstName: candidate.firstName,
                    lastName: candidate.lastName,
                    title: candidate.title,
                    linkedinUrl,
                    email,
                    phone,
                    decisionRole: decisionRole as never,
                    source: "People Data Labs",
                    confidenceScore,
                    discoveredAt: new Date(),
                    discoveredByAgentTaskId: deps.taskId,
                    verificationStatus: "CONFIRMED",
                  },
                });

                await auditAgentAction({
                  agentInstanceId: deps.agentInstanceId,
                  action: "contact.discovered_by_agent",
                  entityType: "contact",
                  entityId: contact.id,
                  after: { firstName: candidate.firstName, lastName: candidate.lastName, title: candidate.title, confidenceScore },
                });

                log(deps.taskId, "records persisted", { contactId: contact.id, firstName: candidate.firstName, lastName: candidate.lastName, confidenceScore });
                contactsCreated.push({
                  contactId: contact.id,
                  firstName: candidate.firstName,
                  lastName: candidate.lastName,
                  title: candidate.title,
                  fields: candidate.fields,
                  sourceUrl: candidate.sourceUrl,
                  confidenceScore,
                });
              }
            }
          }
        } else {
          patternsFailed.push("People Data Labs no configurada (PEOPLEDATALABS_API_KEY ausente)");
        }

        log(deps.taskId, cancelled ? "contact intelligence cancelled" : "contact intelligence completed", {
          contactsCreated: contactsCreated.length,
          candidatesFound,
          duplicatesSkipped,
          insufficientDataSkipped,
          irrelevantTitleSkipped,
        });

        if (cancelled) {
          throw new AppError(499, "CONTACT_INTELLIGENCE_CANCELLED", "Búsqueda de contactos cancelada por el usuario.");
        }

        return {
          contactsCreated,
          candidatesFound,
          duplicatesSkipped,
          insufficientDataSkipped,
          irrelevantTitleSkipped,
          sourcesUsed: Array.from(sourcesUsed),
          patternsFailed,
        };
      },
    },

    // ---- findEmail: F4.7 — Website Intelligence primero (gratis), Hunter.io
    // como respaldo pago, verificación real antes de persistir cualquier
    // estado distinto de NOT_VERIFIED. Nunca envía nada. ----
    {
      ...findEmailToolStub,
      async execute(input: z.infer<typeof findEmailInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
        if (!company) throw AppError.notFound("Company not found");

        log(deps.taskId, "email intelligence started", { companyId: company.id, companyName: company.name });

        const contacts = input.contactId
          ? await scopedDb.contact.findMany({ where: { id: input.contactId, companyId: company.id } })
          : await scopedDb.contact.findMany({
              where: { companyId: company.id, emailVerificationStatus: { not: "VERIFIED" } },
            });

        const sourcesUsed = new Set<string>();
        const patternsFailed: string[] = [];
        const contactsUpdated: EmailUpdatedContact[] = [];
        let emailsFound = 0;
        let emailsVerified = 0;
        let companyEmailUpdated = false;
        let websitePagesVisited = 0;
        let cancelled = false;

        // 1) Website Intelligence — una sola corrida por Company, gratis,
        // sin API key (ver website-intelligence/README.md).
        let websiteResult: WebsiteIntelligenceResult | null = null;
        if (company.website) {
          websiteResult = await runWebsiteIntelligence({
            taskId: deps.taskId,
            website: company.website,
            abortSignal: deps.abortSignal,
          });
          if (websiteResult.cancelled) cancelled = true;
          websitePagesVisited = websiteResult.pagesVisited.length;
          patternsFailed.push(...websiteResult.patternsFailed);
          if (websiteResult.genericEmails.length > 0 || websiteResult.namedPeople.length > 0) {
            sourcesUsed.add(`Website (${company.website})`);
          }

          // Company.email (correo público general) — solo si estaba vacío,
          // nunca sobrescribe un valor ya existente.
          if (!cancelled && !company.email && websiteResult.genericEmails.length > 0) {
            const chosen = websiteResult.genericEmails[0]!;
            await scopedDb.company.update({ where: { id: company.id }, data: { email: chosen.email } });
            companyEmailUpdated = true;
            await auditAgentAction({
              agentInstanceId: deps.agentInstanceId,
              action: "company.email_found_by_agent",
              entityType: "company",
              entityId: company.id,
              after: { email: chosen.email, sourceUrl: chosen.sourceUrl },
            });
            log(deps.taskId, "company email found", { companyId: company.id, sourceUrl: chosen.sourceUrl });
          }
        } else {
          patternsFailed.push("Company sin website — Website Intelligence no tiene qué visitar");
        }

        // 2) Hunter.io — solo si hace falta (al menos un contacto sin match
        // todavía en el website) y hay presupuesto disponible. Una sola
        // consulta por Company, nunca una por contacto (cuida el free tier).
        let hunterCandidates: EmailCandidate[] = [];
        if (!cancelled && env.HUNTER_API_KEY) {
          const stillNeedsLookup = contacts.some(
            (c) => !websiteResult?.namedPeople.some((p) => p.email && namesMatch(p, c)),
          );
          if (stillNeedsLookup) {
            const budgetStatus = await getDataProviderBudgetStatus(ctx.tenantId);
            if (budgetStatus.exceeded) {
              log(deps.taskId, "data provider budget exceeded, skipping Hunter email discovery", { ...budgetStatus });
              patternsFailed.push(`presupuesto de proveedor de datos excedido ($${budgetStatus.spentUsd.toFixed(2)}/$${budgetStatus.budgetUsd.toFixed(2)})`);
            } else {
              const domain = deriveDomain(company.website);
              const result = await searchHunterEmails(
                { taskId: deps.taskId, companyName: company.name, companyWebsite: company.website, domain, limit: 10, abortSignal: deps.abortSignal },
                env.HUNTER_API_KEY,
              );
              if (result.costUsd > 0) deps.usage.recordExternalCost(result.costUsd);
              if (result.cancelled) {
                cancelled = true;
              } else {
                patternsFailed.push(...result.patternsFailed);
                for (const s of result.sourcesUsed) sourcesUsed.add(s);
                hunterCandidates = result.candidates;

                // Respaldo de Company.email si el sitio no trajo nada.
                if (!company.email && !companyEmailUpdated) {
                  const generic = hunterCandidates.find((c) => !c.firstName && !c.lastName);
                  if (generic) {
                    await scopedDb.company.update({ where: { id: company.id }, data: { email: generic.email } });
                    companyEmailUpdated = true;
                    log(deps.taskId, "company email found", { companyId: company.id, provider: "Hunter.io" });
                  }
                }
              }
            }
          }
        } else if (!env.HUNTER_API_KEY) {
          patternsFailed.push("Hunter.io no configurada (HUNTER_API_KEY ausente)");
        }

        // 3) Por cada Contact: matchear un email (website > Hunter),
        // verificar, y persistir respetando la regla de no-downgrade
        // (nunca sobrescribir un email VERIFIED con uno de menor confianza).
        for (const contact of contacts) {
          if (cancelled) break;
          if (contact.emailVerificationStatus === "VERIFIED") continue; // ya está en el estado máximo, nada que hacer

          let matchedEmail: string | null = null;
          let matchedSource: string | null = null;
          let matchedSourceUrl: string | null = null;
          let matchedProvider: string | null = null;

          const websiteMatch = websiteResult?.namedPeople.find((p): p is WebsiteNamedPerson & { email: string } => !!p.email && namesMatch(p, contact));
          if (websiteMatch) {
            matchedEmail = websiteMatch.email;
            matchedSource = "Website (about/team page)";
            matchedSourceUrl = websiteMatch.sourceUrl;
          } else {
            const hunterMatch = hunterCandidates.find((c) => c.firstName && c.lastName && namesMatch({ firstName: c.firstName, lastName: c.lastName }, contact));
            if (hunterMatch) {
              matchedEmail = hunterMatch.email;
              matchedSource = "Hunter.io";
              matchedSourceUrl = hunterMatch.sourceUrl;
              matchedProvider = "Hunter.io";
            }
          }

          if (!matchedEmail) continue; // NOT_FOUND honesto — no se inventa ni por patrón ni por inferencia

          emailsFound++;

          // Conflicto: un email ya VERIFIED nunca se toca (ya excluido arriba
          // por el `continue`), pero un email ya presente con otro estado
          // sigue el mismo criterio — el nuevo dato reemplaza porque no hay
          // nada de mayor confianza que proteger acá.
          const verification = env.HUNTER_API_KEY
            ? await verifyEmailWithHunter({ taskId: deps.taskId, email: matchedEmail, abortSignal: deps.abortSignal }, env.HUNTER_API_KEY)
            : unknownVerificationResult("", "sin proveedor de verificación configurado (HUNTER_API_KEY ausente)");
          if (verification.costUsd > 0) deps.usage.recordExternalCost(verification.costUsd);
          if (verification.cancelled) {
            cancelled = true;
            break;
          }
          if (verification.status !== "UNKNOWN") emailsVerified++;

          const updated = await scopedDb.contact.update({
            where: { id: contact.id },
            data: {
              email: matchedEmail,
              emailSource: matchedSource,
              emailSourceUrl: matchedSourceUrl,
              emailDiscoveryProvider: matchedProvider,
              emailVerificationProvider: verification.provider || null,
              emailVerificationStatus: verification.status,
              emailConfidenceScore: verification.confidenceScore,
              emailDiscoveredAt: new Date(),
              emailVerifiedAt: new Date(),
            },
          });

          await auditAgentAction({
            agentInstanceId: deps.agentInstanceId,
            action: "contact.email_found_by_agent",
            entityType: "contact",
            entityId: contact.id,
            after: { email: matchedEmail, emailSource: matchedSource, emailVerificationStatus: verification.status },
          });

          log(deps.taskId, "email persisted", { contactId: contact.id, emailVerificationStatus: verification.status, emailSource: matchedSource });
          contactsUpdated.push({
            contactId: updated.id,
            firstName: updated.firstName,
            lastName: updated.lastName,
            email: updated.email,
            emailSource: updated.emailSource,
            emailVerificationStatus: updated.emailVerificationStatus,
            emailConfidenceScore: updated.emailConfidenceScore,
          });
        }

        log(deps.taskId, cancelled ? "email intelligence cancelled" : "email intelligence completed", {
          contactsProcessed: contacts.length,
          emailsFound,
          emailsVerified,
          companyEmailUpdated,
          websitePagesVisited,
        });

        if (cancelled) {
          throw new AppError(499, "EMAIL_INTELLIGENCE_CANCELLED", "Búsqueda de emails cancelada por el usuario.");
        }

        return {
          contactsProcessed: contacts.length,
          emailsFound,
          emailsVerified,
          contactsUpdated,
          companyEmailUpdated,
          websitePagesVisited,
          sourcesUsed: Array.from(sourcesUsed),
          patternsFailed,
        };
      },
    },
  ];
}
