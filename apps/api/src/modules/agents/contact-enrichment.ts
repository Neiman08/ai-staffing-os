import { getTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { env } from "../../core/env";
import { logAuditEvent } from "../../core/audit-log";
import { getDataProviderBudgetStatus } from "./data-provider-budget";
import { searchPeopleDataLabs } from "./tools/contact-providers/people-data-labs";
import type { ContactCandidate } from "./tools/contact-providers/types";
import { searchHunterEmails } from "./tools/email-providers/hunter";
import type { EmailCandidate } from "./tools/email-providers/types";
import type { WebsiteNamedPerson } from "./tools/website-intelligence/types";
import { mapTitleToDecisionRole, computeContactConfidenceScore } from "./tools/contact-intelligence-tools.impl";
import { matchTitleToPlannedRole } from "../ceo-intelligence/contact-role-match";
import { validateEmailTrust } from "../ceo-intelligence/email-trust";
import type { DecisionRolePlan } from "../ceo-intelligence/role-planning";
import { rankContact, classifyAuthorityLevel } from "../ceo-intelligence/contact-ranking";
import type { ProviderStatusValue } from "@ai-staffing-os/agents";

/**
 * F7.7 + F15: Contact Intelligence -- wiring impuro entre proveedores de
 * personas reales y el rolePlan de F7.6 (role-planning.ts) para el
 * pipeline de mission-executor.ts. Corre SOLO cuando F7.6 construyó un
 * rolePlan con al menos un rol planificado -- nunca busca contactos
 * "por si acaso" ni con una lista de cargos genérica. QUÉ roles buscar
 * ya lo decidió F7.6; acá se decide QUIÉN (persona real, nunca
 * inventada).
 *
 * F15 (hallazgo real del PO: "People Data Labs será solo una fuente de
 * información"): antes de este fix, People Data Labs era la ÚNICA
 * fuente de personas -- un 402/cuenta agotada/sin resultados terminaba
 * la búsqueda de contactos por completo para esa Company, aunque
 * Website Intelligence ya hubiera crawleado sus páginas de Team/
 * Leadership/About/Contact/Careers (ver website-intelligence/extract.ts)
 * y encontrado un nombre+cargo real ahí mismo. Ahora es una CASCADA,
 * en orden, cada fuente solo corre si la anterior no cubrió todos los
 * roles planificados:
 *   1. People Data Labs (paga, la más completa cuando funciona).
 *   2. Website Intelligence `namedPeople` -- YA extraído en el mismo
 *      crawl que hizo company-enrichment.ts para los emails
 *      organizacionales (F7.4), nunca un segundo request al sitio.
 *   3. Hunter.io Domain Search -- también trae nombre+cargo, no solo
 *      emails genéricos (ver tools/email-providers/hunter.ts).
 * Si NINGUNA fuente encuentra una persona real, la Company queda sin
 * Contact -- nunca se inventa uno de relleno. discovery-conversion.ts
 * decide entonces si hay un canal organizacional (email verificado/
 * riesgoso) para marcarla "lista para contacto organizacional", o si
 * queda pendiente de investigación manual.
 *
 * Separación explícita de las otras "formas de contacto" ya existentes
 * en el sistema, nunca mezcladas:
 * - Email organizacional (info@, hr@...) -- CompanyContactPoint, F7.4,
 *   sin dueño humano identificado.
 * - Rol sin persona identificada -- un target role de rolePlan que
 *   ningún candidato real de NINGUNA fuente matcheó
 *   (`rolesWithoutContact`, reportado honestamente, nunca inventado).
 * - Contacto personal -- Contact, esta fase, SOLO cuando alguna fuente
 *   real devuelve un firstName+lastName real matcheando un rol
 *   planificado.
 *
 * Nunca convierte un email organizacional en persona: la única fuente
 * de `firstName`/`lastName` acá son los 3 proveedores de personas de
 * arriba, y un candidato sin ambos se descarta (`insufficientDataSkipped`),
 * nunca se completa con datos de la Company. Nunca crea Lead/
 * Opportunity/Campaign/outreach.
 */

export interface ContactProviderPort {
  searchPeopleDataLabs: typeof searchPeopleDataLabs;
}

export interface HunterContactProviderPort {
  searchHunterEmails: typeof searchHunterEmails;
}

const REAL_CONTACT_PROVIDER: ContactProviderPort = { searchPeopleDataLabs };
const REAL_HUNTER_PROVIDER: HunterContactProviderPort = { searchHunterEmails };

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
  // F15: personas reales ya extraídas por Website Intelligence en el
  // MISMO crawl que company-enrichment.ts ya hizo para esta Company --
  // segunda fuente de la cascada, nunca un crawl nuevo. `undefined`/[]
  // cuando no hay website o el crawl no encontró ninguna.
  websiteNamedPeople?: WebsiteNamedPerson[];
  // F15: tercera fuente de la cascada -- inyección para tests, mismo
  // criterio que contactProvider.
  hunterProvider?: HunterContactProviderPort;
  hunterApiKey?: string;
}

export interface CreatedContactRecord {
  contactId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  matchedRole: string;
  confidenceScore: number;
  emailDomainTrust: "VERIFIED" | "RISKY" | "INVALID" | "UNKNOWN" | null;
  // F7.8
  rankingTier: "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE" | "LOW_CONFIDENCE" | "REJECTED";
  rankingScore: number;
  // F15: qué fuente real encontró a esta persona -- nunca oculto,
  // espejo literal de Contact.source.
  source: "People Data Labs" | "Website Intelligence" | "Hunter.io";
}

export interface ContactEnrichmentReport {
  candidatesFound: number;
  contactsCreated: CreatedContactRecord[];
  duplicatesSkipped: number;
  insufficientDataSkipped: number;
  roleMismatchSkipped: number;
  // Roles que rolePlan pidió pero para los que ningún candidato real de
  // NINGUNA fuente matcheó -- honesto, nunca se inventa un contacto de
  // relleno.
  rolesWithoutContact: string[];
  sourcesUsed: string[];
  patternsFailed: string[];
  // F16 debt fix: proveedores CONSIDERADOS por esta cascada (PDL,
  // Hunter.io) pero nunca intentados en absoluto -- credenciales
  // ausentes o presupuesto de proveedor de datos excedido, siempre
  // decidido ANTES de cualquier request real. Separado a propósito de
  // patternsFailed (que sigue reservado para intentos reales que sí
  // salieron -- 402/429/errores de red, incluido el eco del health-gate
  // de provider-health.ts para no repetir la misma llamada condenada por
  // cada empresa) -- nunca se mezclan, un proveedor con un intento real
  // fallido/degradado NUNCA aparece acá.
  providersOmitted: string[];
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
    providersOmitted: [],
    providerStatus: "NOT_CONFIGURED",
    costUsd: 0,
    cancelled: false,
  };
}

// F15: dominio sin protocolo/www -- misma lógica exacta que
// contact-intelligence-tools.impl.ts's deriveDomain (no exportada ahí,
// se duplica acá a propósito, mismo criterio de "mirror the shape, not
// a cross-layer import" ya usado en el resto del código).
function deriveDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// F15: shape común intermedio -- cada fuente (PDL/Website/Hunter) tiene
// su propio contrato real, este es el punto único donde convergen antes
// de la lógica compartida de matching/dedup/ranking/creación. Nunca se
// inventa un campo que la fuente no trajo -- cada adaptador de abajo
// solo mapea 1:1.
interface CascadeCandidate {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  discoveryConfidenceScore: number;
}

function fromPdlCandidate(c: ContactCandidate): CascadeCandidate {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    title: c.title,
    email: c.fields.email?.status === "CONFIRMED" ? (c.fields.email.value as string) : null,
    linkedinUrl: c.fields.linkedinUrl?.status === "CONFIRMED" ? (c.fields.linkedinUrl.value as string) : null,
    phone: c.fields.phone?.status === "CONFIRMED" ? (c.fields.phone.value as string) : null,
    discoveryConfidenceScore: computeContactConfidenceScore(c.fields),
  };
}

// F15: extracción de extract.ts ya exige nombre+cargo+mailto en la
// misma tarjeta de la propia página de la empresa -- evidencia fuerte
// aunque no tan multi-campo como PDL. Misma fórmula base que
// computeContactConfidenceScore (0.5 nombre+empresa, +0.1 título,
// +0.15 email), sin LinkedIn/teléfono (esta fuente nunca los trae).
function fromWebsiteNamedPerson(p: WebsiteNamedPerson): CascadeCandidate {
  let score = 0.5;
  if (p.title) score += 0.1;
  if (p.email) score += 0.15;
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    title: p.title,
    email: p.email,
    linkedinUrl: null,
    phone: null,
    discoveryConfidenceScore: Math.min(1, score),
  };
}

function fromHunterCandidate(c: EmailCandidate): CascadeCandidate {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    title: c.title,
    email: c.email,
    linkedinUrl: null,
    phone: null,
    // Hunter ya normaliza su propio confidence a 0-1 (hunter.ts) -- si
    // no vino, se usa la misma base "nombre confirmado" que las otras fuentes.
    discoveryConfidenceScore: c.confidenceScore ?? 0.5,
  };
}

type CascadeOutcome =
  | { kind: "insufficient_data" }
  | { kind: "role_mismatch" }
  | { kind: "duplicate" }
  | { kind: "created"; record: CreatedContactRecord };

/**
 * Procesa UN candidato de CUALQUIER fuente con el mismo criterio
 * exacto: nombre completo real -> rol matcheado -> no duplicado ->
 * ranking -> Contact creado. Compartido por las 3 fuentes de la
 * cascada -- nunca una regla distinta según de dónde vino el candidato.
 */
async function processCandidate(
  candidate: CascadeCandidate,
  source: CreatedContactRecord["source"],
  ctx: { tenantId: string },
  params: ContactEnrichmentParams,
  targetRoles: string[],
  providerStatusForRanking: ProviderStatusValue,
): Promise<CascadeOutcome> {
  if (!candidate.firstName || !candidate.lastName) {
    return { kind: "insufficient_data" };
  }

  const matchedRole = matchTitleToPlannedRole(candidate.title, targetRoles, mapTitleToDecisionRole);
  if (!matchedRole) {
    return { kind: "role_mismatch" };
  }

  const existing = await scopedDb.contact.findFirst({
    where: {
      companyId: params.companyId,
      OR: [
        ...(candidate.email ? [{ email: candidate.email }] : []),
        ...(candidate.linkedinUrl ? [{ linkedinUrl: candidate.linkedinUrl }] : []),
        { firstName: { equals: candidate.firstName, mode: "insensitive" as const }, lastName: { equals: candidate.lastName, mode: "insensitive" as const } },
      ],
    },
  });
  if (existing) {
    log(params.taskId, "duplicate discarded", { source, firstName: candidate.firstName, lastName: candidate.lastName, existingContactId: existing.id });
    return { kind: "duplicate" };
  }

  // Confianza de dominio del email personal (si vino) -- reutiliza
  // email-trust.ts (F7.4), informativo solamente: nunca se persiste
  // como emailVerificationStatus acá (esa verificación real de
  // entregabilidad sigue siendo trabajo separado de findEmail/F4.7,
  // no se duplica ni se simula en esta fase).
  const emailDomainTrust = candidate.email ? validateEmailTrust({ rawEmail: candidate.email, companyWebsite: params.companyWebsite }).status : null;
  const decisionRole = mapTitleToDecisionRole(candidate.title);

  const now = new Date();
  const rolePriority = params.rolePlan!.targetRoles.find((r) => r.role === matchedRole)?.priority ?? null;
  const ranking = rankContact({
    companyMatch: true,
    domainTrust: emailDomainTrust,
    roleMatch: true,
    rolePriority,
    authorityLevel: classifyAuthorityLevel(decisionRole),
    emailVerificationStatus: "NOT_VERIFIED",
    discoveryConfidenceScore: candidate.discoveryConfidenceScore,
    providerStatus: providerStatusForRanking,
    discoveredAt: now,
    now,
  });

  const contact = await scopedDb.contact.create({
    data: {
      tenantId: ctx.tenantId,
      companyId: params.companyId,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      title: candidate.title,
      linkedinUrl: candidate.linkedinUrl,
      email: candidate.email,
      phone: candidate.phone,
      decisionRole: decisionRole as never,
      source,
      confidenceScore: candidate.discoveryConfidenceScore,
      discoveredAt: now,
      discoveredByAgentTaskId: params.taskId,
      verificationStatus: "CONFIRMED",
      rankingTier: ranking.tier,
      rankingScore: ranking.score,
      rankingReasons: ranking.reasons,
      rankedAt: now,
    },
  });

  await logAuditEvent({
    action: "contact.discovered_by_agent",
    entityType: "contact",
    entityId: contact.id,
    after: {
      source,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      title: candidate.title,
      matchedRole,
      confidenceScore: candidate.discoveryConfidenceScore,
      rankingTier: ranking.tier,
      rankingScore: ranking.score,
    },
  });

  log(params.taskId, "contact persisted", {
    contactId: contact.id,
    source,
    matchedRole,
    confidenceScore: candidate.discoveryConfidenceScore,
    rankingTier: ranking.tier,
    rankingScore: ranking.score,
  });

  return {
    kind: "created",
    record: {
      contactId: contact.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      title: candidate.title,
      matchedRole,
      confidenceScore: candidate.discoveryConfidenceScore,
      emailDomainTrust,
      rankingTier: ranking.tier,
      rankingScore: ranking.score,
      source,
    },
  };
}

/**
 * Paso F7.7/F15 del pipeline, para UNA Company ya persistida (F7.3) con
 * un rolePlan ya construido (F7.6): busca personas reales de decisión
 * en cascada (People Data Labs -> Website Intelligence -> Hunter.io),
 * filtra client-side por los roles PLANIFICADOS (nunca la lista
 * genérica de cargos prioritarios del agente clásico), deduplica contra
 * Contact ya existentes, y persiste solo los candidatos con nombre real
 * y rol matcheado.
 */
export async function enrichCompanyWithDecisionContacts(params: ContactEnrichmentParams): Promise<ContactEnrichmentReport> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const targetRoles = params.rolePlan?.targetRoles.map((r) => r.role) ?? [];
  if (targetRoles.length === 0) {
    return emptyReport(["rolePlan sin roles planificados -- Contact Intelligence no corre sin un objetivo real"]);
  }

  const matchedRoles = new Set<string>();
  const contactsCreated: CreatedContactRecord[] = [];
  const sourcesUsed = new Set<string>();
  const patternsFailed: string[] = [];
  const providersOmitted: string[] = [];
  let candidatesFound = 0;
  let duplicatesSkipped = 0;
  let insufficientDataSkipped = 0;
  let roleMismatchSkipped = 0;
  let costUsd = 0;
  let providerStatus: ProviderStatusValue = "NOT_CONFIGURED";
  let cancelled = false;

  const remainingRoles = () => targetRoles.filter((r) => !matchedRoles.has(r));

  async function applyOutcome(outcome: CascadeOutcome, sourceLabel: string): Promise<void> {
    candidatesFound += 1;
    if (outcome.kind === "insufficient_data") insufficientDataSkipped += 1;
    else if (outcome.kind === "role_mismatch") roleMismatchSkipped += 1;
    else if (outcome.kind === "duplicate") duplicatesSkipped += 1;
    else {
      matchedRoles.add(outcome.record.matchedRole);
      contactsCreated.push(outcome.record);
      sourcesUsed.add(sourceLabel);
    }
  }

  // ---------- Fuente 1: People Data Labs ----------
  const pdlApiKey = params.peopleDataLabsApiKey ?? env.PEOPLEDATALABS_API_KEY;
  if (!pdlApiKey) {
    // F16 debt fix: esto es una OMISIÓN real (proveedor considerado por
    // la cascada, nunca intentado por falta de credenciales) -- va a
    // providersOmitted, nunca a patternsFailed (ese campo queda
    // reservado para intentos reales que sí salieron, ver el comentario
    // en ContactEnrichmentReport).
    providersOmitted.push("People Data Labs omitido: PEOPLEDATALABS_API_KEY no configurada -- se continúa con las demás fuentes.");
  } else {
    const budgetStatus = await getDataProviderBudgetStatus(ctx.tenantId);
    if (budgetStatus.exceeded) {
      log(params.taskId, "data provider budget exceeded, skipping PDL", { ...budgetStatus });
      providersOmitted.push(
        `People Data Labs omitido: presupuesto de proveedor de datos excedido ($${budgetStatus.spentUsd.toFixed(2)}/$${budgetStatus.budgetUsd.toFixed(2)}) -- se continúa con las demás fuentes.`,
      );
    } else {
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
        pdlApiKey,
      );

      providerStatus = result.providerStatus;
      costUsd += result.costUsd;
      patternsFailed.push(...result.patternsFailed);

      if (result.cancelled) {
        cancelled = true;
      } else {
        for (const candidate of result.candidates as ContactCandidate[]) {
          const outcome = await processCandidate(fromPdlCandidate(candidate), "People Data Labs", ctx, params, targetRoles, result.providerStatus);
          await applyOutcome(outcome, "People Data Labs");
        }
      }
    }
  }

  // ---------- Fuente 2: Website Intelligence (namedPeople ya crawleado) ----------
  // Nunca corre si ya se cubrieron todos los roles, o si el usuario
  // canceló la misión durante PDL -- misma propagación de cancelación
  // inmediata que el resto del pipeline (F7.9).
  if (!cancelled && remainingRoles().length > 0 && (params.websiteNamedPeople?.length ?? 0) > 0) {
    for (const person of params.websiteNamedPeople!) {
      const outcome = await processCandidate(fromWebsiteNamedPerson(person), "Website Intelligence", ctx, params, targetRoles, "AVAILABLE");
      await applyOutcome(outcome, "Website Intelligence");
    }
  }

  // ---------- Fuente 3: Hunter.io Domain Search ----------
  const hunterApiKey = params.hunterApiKey ?? env.HUNTER_API_KEY;
  if (!cancelled && remainingRoles().length > 0 && !hunterApiKey) {
    // F16 debt fix: misma razón que PDL arriba -- omisión real, va a
    // providersOmitted.
    providersOmitted.push("Hunter.io omitido: HUNTER_API_KEY no configurada.");
  }
  if (!cancelled && remainingRoles().length > 0 && hunterApiKey) {
    const domain = deriveDomain(params.companyWebsite);
    if (!domain) {
      patternsFailed.push(`${params.companyName}:hunter_domain_search (sin dominio derivable de companyWebsite)`);
    } else {
      const hunterProvider = params.hunterProvider ?? REAL_HUNTER_PROVIDER;
      const hunterResult = await hunterProvider.searchHunterEmails(
        {
          taskId: params.taskId,
          companyName: params.companyName,
          companyWebsite: params.companyWebsite,
          domain,
          limit: Math.min(targetRoles.length * 2, 10),
          abortSignal: params.abortSignal,
        },
        hunterApiKey,
      );

      costUsd += hunterResult.costUsd;
      patternsFailed.push(...hunterResult.patternsFailed);
      // Solo se sobreescribe providerStatus si PDL nunca corrió/no dio
      // señal útil -- el estado más informativo (el de la última fuente
      // que realmente respondió) es el que se reporta.
      if (hunterResult.providerStatus !== "AVAILABLE" || providerStatus === "NOT_CONFIGURED") {
        providerStatus = hunterResult.providerStatus;
      }

      if (hunterResult.cancelled) {
        cancelled = true;
      } else {
        for (const candidate of hunterResult.candidates as EmailCandidate[]) {
          const outcome = await processCandidate(fromHunterCandidate(candidate), "Hunter.io", ctx, params, targetRoles, hunterResult.providerStatus);
          await applyOutcome(outcome, "Hunter.io");
        }
      }
    }
  }

  const rolesWithoutContact = remainingRoles();

  log(params.taskId, "contact enrichment completed", {
    companyId: params.companyId,
    candidatesFound,
    contactsCreated: contactsCreated.length,
    duplicatesSkipped,
    insufficientDataSkipped,
    roleMismatchSkipped,
    rolesWithoutContact,
    sourcesUsed: Array.from(sourcesUsed),
    providersOmitted,
  });

  return {
    candidatesFound,
    contactsCreated,
    duplicatesSkipped,
    insufficientDataSkipped,
    roleMismatchSkipped,
    rolesWithoutContact,
    sourcesUsed: Array.from(sourcesUsed),
    patternsFailed,
    providersOmitted,
    providerStatus,
    costUsd,
    cancelled,
  };
}
