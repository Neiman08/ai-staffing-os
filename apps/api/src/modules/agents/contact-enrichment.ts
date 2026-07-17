import { getTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { logAuditEvent } from "../../core/audit-log";
import { getDataProviderBudgetStatus } from "./data-provider-budget";
import { searchPeopleDataLabs } from "./tools/contact-providers/people-data-labs";
import type { ContactCandidate } from "./tools/contact-providers/types";
import { mapTitleToDecisionRole, computeContactConfidenceScore } from "./tools/contact-intelligence-tools.impl";
import { matchTitleToPlannedRole } from "../ceo-intelligence/contact-role-match";
import { validateEmailTrust } from "../ceo-intelligence/email-trust";
import type { DecisionRolePlan } from "../ceo-intelligence/role-planning";
import type { ProviderStatusValue } from "@ai-staffing-os/agents";

/**
 * F7.7: Contact Intelligence -- wiring impuro entre People Data Labs
 * (proveedor existente desde F4.6, sin modificar) y el rolePlan de F7.6
 * (role-planning.ts) para el pipeline NUEVO de mission-executor.ts.
 * Corre SOLO cuando F7.6 construyó un rolePlan con al menos un rol
 * planificado -- nunca busca contactos "por si acaso" ni con una lista
 * de cargos genérica. QUÉ roles buscar ya lo decidió F7.6; acá se
 * decide QUIÉN (persona real, nunca inventada).
 *
 * Separación explícita de las otras "formas de contacto" ya existentes
 * en el sistema, nunca mezcladas:
 * - Email organizacional (info@, hr@...) -- CompanyContactPoint, F7.4,
 *   sin dueño humano identificado.
 * - Contacto genérico -- mismo CompanyContactPoint, tipo OTHER/SUPPORT/etc.
 * - Rol sin persona identificada -- un target role de rolePlan que
 *   ningún candidato real matcheó (`rolesWithoutContact`, reportado
 *   honestamente, nunca inventado).
 * - Contacto personal -- Contact, esta fase, SOLO cuando PDL devuelve
 *   un firstName+lastName real matcheando un rol planificado.
 *
 * Nunca convierte un email organizacional en persona: la única fuente
 * de `firstName`/`lastName` acá es el proveedor de personas (PDL), y un
 * candidato sin ambos se descarta (`insufficientDataSkipped`), nunca se
 * completa con datos de la Company. Nunca crea Lead/Opportunity/
 * Campaign/outreach.
 */

export interface ContactProviderPort {
  searchPeopleDataLabs: typeof searchPeopleDataLabs;
}

const REAL_CONTACT_PROVIDER: ContactProviderPort = { searchPeopleDataLabs };

export interface ContactEnrichmentParams {
  taskId: string;
  companyId: string;
  companyName: string;
  companyWebsite: string | null;
  companyState: string | null;
  companyCity: string | null;
  industryName: string;
  rolePlan: DecisionRolePlan | null;
  abortSignal?: AbortSignal;
  // Inyección para tests -- nunca se llama a People Data Labs real en
  // un test unitario. Default: el módulo real (sin modificar).
  contactProvider?: ContactProviderPort;
  peopleDataLabsApiKey?: string;
}

export interface CreatedContactRecord {
  contactId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  matchedRole: string;
  confidenceScore: number;
  emailDomainTrust: "VERIFIED" | "RISKY" | "INVALID" | "UNKNOWN" | null;
}

export interface ContactEnrichmentReport {
  candidatesFound: number;
  contactsCreated: CreatedContactRecord[];
  duplicatesSkipped: number;
  insufficientDataSkipped: number;
  roleMismatchSkipped: number;
  // Roles que rolePlan pidió pero para los que ningún candidato real
  // matcheó -- honesto, nunca se inventa un contacto de relleno.
  rolesWithoutContact: string[];
  sourcesUsed: string[];
  patternsFailed: string[];
  providerStatus: ProviderStatusValue;
  costUsd: number;
  cancelled: boolean;
}

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[contact-enrichment] ${event}`, JSON.stringify({ taskId, ...data }));
}

function emptyReport(patternsFailed: string[] = [], rolesWithoutContact: string[] = []): ContactEnrichmentReport {
  return {
    candidatesFound: 0,
    contactsCreated: [],
    duplicatesSkipped: 0,
    insufficientDataSkipped: 0,
    roleMismatchSkipped: 0,
    rolesWithoutContact,
    sourcesUsed: [],
    patternsFailed,
    providerStatus: "NOT_CONFIGURED",
    costUsd: 0,
    cancelled: false,
  };
}

/**
 * Paso F7.7 del pipeline, para UNA Company ya persistida (F7.3) con un
 * rolePlan ya construido (F7.6): busca personas reales de decisión vía
 * People Data Labs, filtra client-side por los roles PLANIFICADOS
 * (nunca la lista genérica de cargos prioritarios del agente clásico),
 * deduplica contra Contact ya existentes, y persiste solo los
 * candidatos con nombre real y rol matcheado.
 */
export async function enrichCompanyWithDecisionContacts(params: ContactEnrichmentParams): Promise<ContactEnrichmentReport> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const targetRoles = params.rolePlan?.targetRoles.map((r) => r.role) ?? [];
  if (targetRoles.length === 0) {
    return emptyReport(["rolePlan sin roles planificados -- Contact Intelligence no corre sin un objetivo real"]);
  }

  const apiKey = params.peopleDataLabsApiKey ?? env.PEOPLEDATALABS_API_KEY;
  if (!apiKey) {
    return emptyReport(["People Data Labs no configurada (PEOPLEDATALABS_API_KEY ausente)"], targetRoles);
  }

  const budgetStatus = await getDataProviderBudgetStatus(ctx.tenantId);
  if (budgetStatus.exceeded) {
    log(params.taskId, "data provider budget exceeded, skipping contact search", { ...budgetStatus });
    return emptyReport(
      [`presupuesto de proveedor de datos excedido ($${budgetStatus.spentUsd.toFixed(2)}/$${budgetStatus.budgetUsd.toFixed(2)})`],
      targetRoles,
    );
  }

  const provider = params.contactProvider ?? REAL_CONTACT_PROVIDER;
  const limit = Math.min(targetRoles.length * 2, 10);

  const result = await provider.searchPeopleDataLabs(
    {
      taskId: params.taskId,
      companyName: params.companyName,
      companyWebsite: params.companyWebsite,
      companyState: params.companyState,
      companyCity: params.companyCity,
      industryName: params.industryName,
      priorityTitles: targetRoles,
      limit,
      abortSignal: params.abortSignal,
    },
    apiKey,
  );

  if (result.cancelled) {
    return { ...emptyReport(result.patternsFailed, targetRoles), cancelled: true, providerStatus: result.providerStatus };
  }

  const matchedRoles = new Set<string>();
  const contactsCreated: CreatedContactRecord[] = [];
  let candidatesFound = 0;
  let duplicatesSkipped = 0;
  let insufficientDataSkipped = 0;
  let roleMismatchSkipped = 0;

  for (const candidate of result.candidates as ContactCandidate[]) {
    candidatesFound++;

    if (!candidate.firstName || !candidate.lastName) {
      insufficientDataSkipped++;
      continue;
    }

    const matchedRole = matchTitleToPlannedRole(candidate.title, targetRoles, mapTitleToDecisionRole);
    if (!matchedRole) {
      roleMismatchSkipped++;
      continue;
    }

    const email = candidate.fields.email?.status === "CONFIRMED" ? (candidate.fields.email.value as string) : null;
    const linkedinUrl = candidate.fields.linkedinUrl?.status === "CONFIRMED" ? (candidate.fields.linkedinUrl.value as string) : null;

    const existing = await scopedDb.contact.findFirst({
      where: {
        companyId: params.companyId,
        OR: [
          ...(email ? [{ email }] : []),
          ...(linkedinUrl ? [{ linkedinUrl }] : []),
          { firstName: { equals: candidate.firstName, mode: "insensitive" as const }, lastName: { equals: candidate.lastName, mode: "insensitive" as const } },
        ],
      },
    });
    if (existing) {
      duplicatesSkipped++;
      log(params.taskId, "duplicate discarded", { firstName: candidate.firstName, lastName: candidate.lastName, existingContactId: existing.id });
      continue;
    }

    // Confianza de dominio del email personal (si vino) -- reutiliza
    // email-trust.ts (F7.4), informativo solamente: nunca se persiste
    // como emailVerificationStatus acá (esa verificación real de
    // entregabilidad sigue siendo trabajo separado de findEmail/F4.7,
    // no se duplica ni se simula en esta fase).
    const emailDomainTrust = email ? validateEmailTrust({ rawEmail: email, companyWebsite: params.companyWebsite }).status : null;

    const confidenceScore = computeContactConfidenceScore(candidate.fields);
    const phone = candidate.fields.phone?.status === "CONFIRMED" ? (candidate.fields.phone.value as string) : null;
    const decisionRole = mapTitleToDecisionRole(candidate.title);

    const contact = await scopedDb.contact.create({
      data: {
        tenantId: ctx.tenantId,
        companyId: params.companyId,
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
        discoveredByAgentTaskId: params.taskId,
        verificationStatus: "CONFIRMED",
      },
    });

    matchedRoles.add(matchedRole);

    await logAuditEvent({
      action: "contact.discovered_by_agent",
      entityType: "contact",
      entityId: contact.id,
      after: { firstName: candidate.firstName, lastName: candidate.lastName, title: candidate.title, matchedRole, confidenceScore },
    });

    log(params.taskId, "contact persisted", { contactId: contact.id, matchedRole, confidenceScore });
    contactsCreated.push({
      contactId: contact.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      title: candidate.title,
      matchedRole,
      confidenceScore,
      emailDomainTrust,
    });
  }

  const rolesWithoutContact = targetRoles.filter((r) => !matchedRoles.has(r));

  log(params.taskId, "contact enrichment completed", {
    companyId: params.companyId,
    candidatesFound,
    contactsCreated: contactsCreated.length,
    duplicatesSkipped,
    insufficientDataSkipped,
    roleMismatchSkipped,
    rolesWithoutContact,
  });

  return {
    candidatesFound,
    contactsCreated,
    duplicatesSkipped,
    insufficientDataSkipped,
    roleMismatchSkipped,
    rolesWithoutContact,
    sourcesUsed: result.sourcesUsed,
    patternsFailed: result.patternsFailed,
    providerStatus: result.providerStatus,
    costUsd: result.costUsd,
    cancelled: false,
  };
}
