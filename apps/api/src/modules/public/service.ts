import type { BrandingConfig } from "@ai-staffing-os/shared";
import { scopedDb } from "../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../core/tenancy/context";
import { getBrandingConfig } from "../../core/branding";
import { AppError } from "../../core/errors";
import { logActivity } from "../../core/activity-log";

export async function getPublicBranding(): Promise<BrandingConfig> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  return getBrandingConfig(ctx.tenantId);
}

export interface PublicIndustry {
  id: string;
  name: string;
  categories: Array<{ id: string; name: string }>;
}

/** F4.8: solo las industrias reales del tenant — nunca inventa categorías nuevas ni una lista genérica de staffing. */
export async function listPublicIndustries(): Promise<PublicIndustry[]> {
  const industries = await scopedDb.industry.findMany({
    include: { categories: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  return industries.map((i) => ({ id: i.id, name: i.name, categories: i.categories }));
}

export interface PublicJobOpening {
  id: string;
  title: string;
  categoryName: string;
  industryName: string;
  city: string | null;
  state: string | null;
  shiftType: string;
  workersNeeded: number;
}

/**
 * F4.8: vacantes reales, nunca de empresas demo, y NUNCA se expone el
 * nombre de la empresa cliente (práctica estándar de la industria de
 * staffing — "Confidential Manufacturing Client", no el nombre real) ni
 * tarifas (billRate/payRate son datos internos de margen). Solo
 * OPEN/PARTIALLY_FILLED — una posición ya cerrada no debe seguir
 * apareciendo como disponible.
 */
export async function listPublicJobOpenings(): Promise<PublicJobOpening[]> {
  const jobOrders = await scopedDb.jobOrder.findMany({
    where: {
      status: { in: ["OPEN", "PARTIALLY_FILLED"] },
      company: { origin: { not: "DEMO_SEED" } },
    },
    include: { category: { include: { industry: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return jobOrders.map((j) => {
    const location = j.location as { city?: string; state?: string } | null;
    return {
      id: j.id,
      title: j.title,
      categoryName: j.category.name,
      industryName: j.category.industry?.name ?? "General",
      city: location?.city ?? null,
      state: location?.state ?? null,
      shiftType: j.shiftType,
      workersNeeded: j.workersNeeded,
    };
  });
}

export interface PublicStats {
  industriesServed: number;
  statesActive: number;
  companiesInNetwork: number;
  aiAgentsActive: number;
}

/**
 * F4.8: SOLO números reales, nunca estimados ni presentados como logro
 * inventado ("miles de colocaciones", "98% satisfacción" — nada de eso
 * sin respaldo real). Excluye siempre origin=DEMO_SEED. Si un número da
 * chico porque el pilot es joven, se muestra chico — nunca se infla.
 */
export async function getPublicStats(): Promise<PublicStats> {
  const [industriesServed, realCompanies, aiAgentsActive] = await Promise.all([
    scopedDb.industry.count(),
    scopedDb.company.findMany({ where: { origin: { not: "DEMO_SEED" } }, select: { state: true } }),
    scopedDb.agentInstance.count({ where: { isActive: true } }),
  ]);
  const statesActive = new Set(realCompanies.map((c) => c.state).filter((s): s is string => !!s)).size;

  return {
    industriesServed,
    statesActive,
    companiesInNetwork: realCompanies.length,
    aiAgentsActive,
  };
}

export interface PublicLeadSubmission {
  companyName: string | null;
  contactName: string;
  email: string;
  phone: string | null;
  industryName: string | null;
  state: string | null;
  city: string | null;
  message: string | null;
  source: "website-contact-form" | "website-request-talent";
}

async function resolveIndustryId(industryName: string | null): Promise<string | null> {
  if (!industryName) return null;
  const industry = await scopedDb.industry.findFirst({ where: { name: industryName } });
  return industry?.id ?? null; // nunca inventa un id si el nombre no matchea uno real
}

/** F4.8 Contact / Request Talent: crea un Lead REAL — nunca envía ningún email todavía. */
export async function submitPublicLead(input: PublicLeadSubmission): Promise<{ leadId: string }> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const industryId = await resolveIndustryId(input.industryName);

  const lead = await scopedDb.lead.create({
    data: {
      tenantId: ctx.tenantId,
      industryId: industryId ?? undefined,
      city: input.city ?? undefined,
      state: input.state ?? undefined,
      source: input.source,
      status: "NEW",
      notes: [
        `Enviado desde el sitio público (${input.source}).`,
        input.companyName ? `Empresa: ${input.companyName}` : null,
        `Contacto: ${input.contactName} <${input.email}>${input.phone ? ` · ${input.phone}` : ""}`,
        input.message ? `Mensaje: ${input.message}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  });

  await logActivity({
    entityType: "lead",
    entityId: lead.id,
    type: "SYSTEM",
    subject: `Lead recibido desde el sitio público (${input.source})`,
    body: input.message ?? undefined,
  });

  return { leadId: lead.id };
}

export interface PublicCandidateApplication {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  yearsExperience: number | null;
  categoryName: string | null;
  resumeUrl: string | null;
  smsOptIn: boolean;
}

/** F4.8 Careers/Candidates "Apply": crea un Candidate REAL — sin ATS completo todavía, sin email. */
export async function submitPublicApplication(input: PublicCandidateApplication): Promise<{ candidateId: string }> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();

  const category = input.categoryName ? await scopedDb.jobCategory.findFirst({ where: { name: input.categoryName } }) : null;

  const candidate = await scopedDb.candidate.create({
    data: {
      tenantId: ctx.tenantId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone ?? undefined,
      city: input.city ?? undefined,
      state: input.state ?? undefined,
      yearsExperience: input.yearsExperience ?? undefined,
      resumeUrl: input.resumeUrl ?? undefined,
      smsOptIn: input.smsOptIn,
      source: "website-careers",
      status: "NEW",
      categories: category ? { connect: [{ id: category.id }] } : undefined,
    },
  });

  await logActivity({
    entityType: "candidate",
    entityId: candidate.id,
    type: "SYSTEM",
    subject: "Aplicación recibida desde el sitio público (Careers)",
  });

  return { candidateId: candidate.id };
}
