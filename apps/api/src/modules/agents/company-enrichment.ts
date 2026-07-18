import { getTenancyContext } from "../../core/tenancy/context";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { AppError } from "../../core/errors";
import { logAuditEvent } from "../../core/audit-log";
import { validateEmailTrust, type EmailTrustResult } from "../ceo-intelligence/email-trust";
import { runWebsiteIntelligence } from "./tools/website-intelligence/crawler";
import type { WebsiteIntelligenceResult } from "./tools/website-intelligence/types";

/**
 * F7.4 Parte B: wiring impuro entre Website Intelligence (existente, sin
 * modificar) y email-trust.ts (F7.4, puro) — pasos 7-10 del pipeline
 * nuevo de mission-executor.ts ("inspeccionar website" -> "extraer
 * emails" -> "validar email" -> "persistir CompanyContactPoint"). Solo
 * procesa `genericEmails` (organizacionales, sin dueño) — nunca
 * `namedPeople` (esos son personas identificadas, Contact Intelligence
 * territory, explícitamente fuera de alcance de F7.4: "No implementar
 * todavía: búsqueda de contactos personales"). Nunca crea Contact, Lead,
 * Opportunity, Campaign — solo CompanyContactPoint + opcionalmente
 * Company.email.
 */

export interface WebsiteIntelligencePort {
  runWebsiteIntelligence: typeof runWebsiteIntelligence;
}

const REAL_WEBSITE_INTELLIGENCE: WebsiteIntelligencePort = { runWebsiteIntelligence };

export interface CompanyEnrichmentParams {
  taskId: string;
  companyId: string;
  abortSignal?: AbortSignal;
  // Inyección para tests — nunca se llama a Website Intelligence real en
  // un test unitario. Default: el módulo real (crawler.ts, sin modificar).
  websiteIntelligence?: WebsiteIntelligencePort;
}

export interface EnrichedEmailRecord {
  email: string;
  status: EmailTrustResult["status"];
  type: EmailTrustResult["type"];
  sourceUrl: string;
  persisted: boolean;
}

// F7.5: subconjunto crudo del crawl de Website Intelligence necesario
// para Hiring Signal Intelligence (hiring-signals.ts) -- nunca se
// re-crawlea el sitio, se reutiliza el mismo resultado ya bajado acá.
export interface WebsiteCrawlSignals {
  hasWebsite: boolean;
  crawlBlocked: boolean;
  hasCareersPage: boolean;
  careersPageUrl: string | null;
  pageTexts: Array<{ url: string; text: string }>;
}

export interface CompanyEnrichmentReport {
  emailsExtracted: number;
  emailsVerified: number;
  emailsRisky: number;
  emailsInvalid: number;
  emailsUnknown: number;
  companyContactPointsCreated: number;
  companyEmailUpdated: boolean;
  websitePagesVisited: number;
  patternsFailed: string[];
  cancelled: boolean;
  emails: EnrichedEmailRecord[];
  websiteSignals: WebsiteCrawlSignals;
}

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[company-enrichment] ${event}`, JSON.stringify({ taskId, ...data }));
}

function emptyReport(patternsFailed: string[] = [], websiteSignals?: Partial<WebsiteCrawlSignals>): CompanyEnrichmentReport {
  return {
    emailsExtracted: 0,
    emailsVerified: 0,
    emailsRisky: 0,
    emailsInvalid: 0,
    emailsUnknown: 0,
    companyContactPointsCreated: 0,
    companyEmailUpdated: false,
    websitePagesVisited: 0,
    patternsFailed,
    cancelled: false,
    emails: [],
    websiteSignals: {
      hasWebsite: false,
      crawlBlocked: false,
      hasCareersPage: false,
      careersPageUrl: null,
      pageTexts: [],
      ...websiteSignals,
    },
  };
}

/**
 * Dedup simple por email normalizado -- Website Intelligence puede
 * encontrar el mismo genérico en más de una página (ej. footer + página
 * de contacto), nunca se procesa dos veces. Se queda con la PRIMERA
 * aparición (mismo criterio que discovery-identity.ts).
 */
function dedupeGenericEmails(result: WebsiteIntelligenceResult): Array<{ email: string; sourceUrl: string }> {
  const seen = new Set<string>();
  const unique: Array<{ email: string; sourceUrl: string }> = [];
  for (const candidate of result.genericEmails) {
    const key = candidate.email.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Pasos 7-10 del pipeline de F7.4 para UNA Company ya persistida (F7.3):
 * visita su website (Website Intelligence, gratis, sin API key), evalúa
 * cada email genérico encontrado (email-trust.ts) contra el dominio
 * oficial de la Company, y persiste CompanyContactPoint solo para
 * VERIFIED/RISKY -- nunca INVALID/UNKNOWN. Actualiza Company.email SOLO
 * si estaba vacío y el primer email VERIFIED encontrado -- nunca
 * sobrescribe un valor ya existente, cualquiera sea su calidad (deuda
 * histórica, backfill separado si hace falta, ver plan §"Company.email").
 */
export async function enrichCompanyWithOrganizationalEmails(params: CompanyEnrichmentParams): Promise<CompanyEnrichmentReport> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const ports = params.websiteIntelligence ?? REAL_WEBSITE_INTELLIGENCE;

  const company = await scopedDb.company.findUnique({ where: { id: params.companyId } });
  if (!company) throw AppError.notFound("Company not found");

  if (!company.website) {
    return emptyReport(["Company sin website — Website Intelligence no tiene qué visitar"]);
  }

  const websiteResult = await ports.runWebsiteIntelligence({
    taskId: params.taskId,
    website: company.website,
    abortSignal: params.abortSignal,
  });

  const websiteSignals: WebsiteCrawlSignals = {
    hasWebsite: true,
    crawlBlocked: websiteResult.blockedByRobots || websiteResult.cancelled,
    hasCareersPage: websiteResult.hasCareersPage,
    careersPageUrl: websiteResult.careersPageUrl,
    pageTexts: websiteResult.pageTexts,
  };

  if (websiteResult.cancelled) {
    return {
      ...emptyReport(websiteResult.patternsFailed, websiteSignals),
      cancelled: true,
      websitePagesVisited: websiteResult.pagesVisited.length,
    };
  }

  const uniqueEmails = dedupeGenericEmails(websiteResult);
  const emails: EnrichedEmailRecord[] = [];
  let emailsVerified = 0;
  let emailsRisky = 0;
  let emailsInvalid = 0;
  let emailsUnknown = 0;
  let companyContactPointsCreated = 0;
  let companyEmailUpdated = false;
  let companyHasEmail = !!company.email;

  for (const candidate of uniqueEmails) {
    const trust = validateEmailTrust({ rawEmail: candidate.email, companyWebsite: company.website });
    const now = new Date();

    if (trust.status === "VERIFIED") emailsVerified++;
    else if (trust.status === "RISKY") emailsRisky++;
    else if (trust.status === "INVALID") emailsInvalid++;
    else emailsUnknown++;

    const shouldPersist = (trust.status === "VERIFIED" || trust.status === "RISKY") && !!trust.normalizedEmail;
    if (shouldPersist) {
      // Nunca degradar (ni siquiera tocar) un punto de contacto que ya
      // existe -- mismo criterio de no-downgrade ya establecido para
      // Contact.emailVerificationStatus (contact-intelligence-tools.impl.ts).
      // Se comprueba existencia primero (en vez de upsert con update:{})
      // para que companyContactPointsCreated cuente creaciones reales,
      // nunca un no-op sobre una fila ya presente.
      // Pre-F11 audit: CompanyContactPoint was just added to STRICT_TENANT_MODELS
      // (see prisma-extension.ts) — per the F8 composite-unique-key limitation
      // (findUnique/upsert redirect to findFirst, which doesn't accept a
      // compound-key field-group name), this must use the plain-field form,
      // same pattern already established by placements/service.ts and
      // payroll/service.ts for their own compound-unique lookups.
      const existing = await scopedDb.companyContactPoint.findFirst({
        where: { companyId: company.id, email: trust.normalizedEmail! },
      });
      if (!existing) {
        await scopedDb.companyContactPoint.create({
          data: {
            tenantId: ctx.tenantId,
            companyId: company.id,
            email: trust.normalizedEmail!,
            type: trust.type,
            sourceUrl: candidate.sourceUrl,
            discoveryProvider: "Website Intelligence",
            verificationStatus: trust.status,
            confidenceScore: trust.confidenceScore,
            discoveredAt: now,
            verifiedAt: now,
          },
        });
        companyContactPointsCreated++;
        log(params.taskId, "contact point persisted", { companyId: company.id, email: trust.normalizedEmail, status: trust.status });

        await logAuditEvent({
          action: "company.contact_point_created_by_agent",
          entityType: "company",
          entityId: company.id,
          after: { email: trust.normalizedEmail, type: trust.type, verificationStatus: trust.status, sourceUrl: candidate.sourceUrl },
        });
      }

      if (!companyHasEmail && trust.status === "VERIFIED" && !companyEmailUpdated) {
        await scopedDb.company.update({ where: { id: company.id }, data: { email: trust.normalizedEmail! } });
        companyEmailUpdated = true;
        companyHasEmail = true;
        log(params.taskId, "company email updated", { companyId: company.id, email: trust.normalizedEmail });
      }
    }

    emails.push({
      email: trust.normalizedEmail ?? candidate.email,
      status: trust.status,
      type: trust.type,
      sourceUrl: candidate.sourceUrl,
      persisted: shouldPersist,
    });
  }

  log(params.taskId, "enrichment completed", {
    companyId: company.id,
    emailsExtracted: uniqueEmails.length,
    emailsVerified,
    emailsRisky,
    emailsInvalid,
    emailsUnknown,
    companyContactPointsCreated,
    companyEmailUpdated,
  });

  return {
    emailsExtracted: uniqueEmails.length,
    emailsVerified,
    emailsRisky,
    emailsInvalid,
    emailsUnknown,
    companyContactPointsCreated,
    companyEmailUpdated,
    websitePagesVisited: websiteResult.pagesVisited.length,
    patternsFailed: websiteResult.patternsFailed,
    cancelled: false,
    emails,
    websiteSignals,
  };
}
