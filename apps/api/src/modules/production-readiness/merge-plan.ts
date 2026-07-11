import { scopedDb } from "../../core/tenancy/prisma-extension";
import { generateDuplicatesReport, type DuplicateGroup } from "./duplicates";

export interface FieldMergeDecision {
  field: string;
  chosenValue: unknown;
  chosenFromId: string;
  reason: string;
}

export interface ReassignmentNeeded {
  entity: string;
  count: number;
  note: string;
}

export interface MergePlan {
  entity: "Company" | "Contact";
  matchType: DuplicateGroup["matchType"];
  matchKey: string;
  primaryId: string;
  primaryReason: string;
  duplicateIds: string[];
  fieldDecisions: FieldMergeDecision[];
  reassignmentsNeeded: ReassignmentNeeded[];
}

export interface MergePlanReport {
  generatedAt: string;
  plans: MergePlan[];
}

/**
 * F4.7.5 §5: PLAN de fusión — de solo lectura, NUNCA fusiona ni borra
 * nada. Elige la Company/Contact "primaria" de un grupo duplicado por
 * confianza real (confidenceScore -> verificationStatus -> más campos
 * completos -> más reciente, en ese orden, nunca al azar), y por cada
 * campo decide qué valor sobrevive explicando el motivo — nunca
 * sobrescribe un dato real con uno de menor confianza.
 *
 * No existe ninguna función `executeMerge` en este commit — ejecutar la
 * fusión (UPDATE real + reasignar Contact/Lead/Opportunity/Activity al
 * primario + AuditLog con before/after completo de ambos registros +
 * borrar los duplicados) es trabajo de una fase posterior, solo tras
 * aprobación explícita del PO sobre CADA fusión o un criterio de
 * aprobación en lote que el PO confirme primero.
 */

const COMPANY_FIELDS = ["website", "phone", "email", "city", "state", "commercialScore", "notes"] as const;
const CONTACT_FIELDS = ["email", "phone", "title", "linkedinUrl", "decisionRole"] as const;

function verificationRank(status: string): number {
  if (status === "CONFIRMED") return 2;
  if (status === "INFERRED") return 1;
  return 0; // UNVERIFIED
}

async function planForCompanyGroup(group: DuplicateGroup): Promise<MergePlan> {
  const rows = await scopedDb.company.findMany({ where: { id: { in: group.ids } } });
  const sorted = [...rows].sort((a, b) => {
    const conf = (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
    if (conf !== 0) return conf;
    const ver = verificationRank(b.verificationStatus) - verificationRank(a.verificationStatus);
    if (ver !== 0) return ver;
    const aFilled = COMPANY_FIELDS.filter((f) => (a as Record<string, unknown>)[f] != null).length;
    const bFilled = COMPANY_FIELDS.filter((f) => (b as Record<string, unknown>)[f] != null).length;
    if (bFilled !== aFilled) return bFilled - aFilled;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  const primary = sorted[0]!;
  const others = sorted.slice(1);

  const fieldDecisions: FieldMergeDecision[] = [];
  for (const field of COMPANY_FIELDS) {
    const primaryValue = (primary as Record<string, unknown>)[field];
    if (primaryValue != null) {
      fieldDecisions.push({ field, chosenValue: primaryValue, chosenFromId: primary.id, reason: "el registro primario ya tiene un valor real — nunca se sobrescribe" });
      continue;
    }
    const donor = others.find((o) => (o as Record<string, unknown>)[field] != null);
    if (donor) {
      fieldDecisions.push({
        field,
        chosenValue: (donor as Record<string, unknown>)[field],
        chosenFromId: donor.id,
        reason: "el primario no tenía este dato — se completa con el duplicado que sí lo tiene",
      });
    }
  }

  const [contactCount, leadCount, opportunityCount, campaignCompanyCount] = await Promise.all([
    scopedDb.contact.count({ where: { companyId: { in: others.map((o) => o.id) } } }),
    scopedDb.lead.count({ where: { companyId: { in: others.map((o) => o.id) } } }),
    scopedDb.opportunity.count({ where: { companyId: { in: others.map((o) => o.id) } } }),
    scopedDb.campaignCompany.count({ where: { companyId: { in: others.map((o) => o.id) } } }),
  ]);

  return {
    entity: "Company",
    matchType: group.matchType,
    matchKey: group.key,
    primaryId: primary.id,
    primaryReason: `confidenceScore=${primary.confidenceScore ?? "null"}, verificationStatus=${primary.verificationStatus}, ${COMPANY_FIELDS.filter((f) => (primary as Record<string, unknown>)[f] != null).length}/${COMPANY_FIELDS.length} campos completos`,
    duplicateIds: others.map((o) => o.id),
    fieldDecisions,
    reassignmentsNeeded: [
      { entity: "Contact", count: contactCount, note: "companyId debería re-apuntar al primario antes de poder borrar los duplicados" },
      { entity: "Lead", count: leadCount, note: "mismo caso" },
      { entity: "Opportunity", count: opportunityCount, note: "mismo caso" },
      { entity: "CampaignCompany", count: campaignCompanyCount, note: "mismo caso — @@unique([campaignId, companyId]) puede generar conflicto si el primario ya está en la misma campaña, revisar caso por caso" },
    ].filter((r) => r.count > 0),
  };
}

async function planForContactGroup(group: DuplicateGroup): Promise<MergePlan> {
  const rows = await scopedDb.contact.findMany({ where: { id: { in: group.ids } } });
  const sorted = [...rows].sort((a, b) => {
    const conf = (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
    if (conf !== 0) return conf;
    const ver = verificationRank(b.verificationStatus) - verificationRank(a.verificationStatus);
    if (ver !== 0) return ver;
    const emailVer = (b.emailVerificationStatus === "VERIFIED" ? 1 : 0) - (a.emailVerificationStatus === "VERIFIED" ? 1 : 0);
    if (emailVer !== 0) return emailVer;
    const aFilled = CONTACT_FIELDS.filter((f) => (a as Record<string, unknown>)[f] != null).length;
    const bFilled = CONTACT_FIELDS.filter((f) => (b as Record<string, unknown>)[f] != null).length;
    if (bFilled !== aFilled) return bFilled - aFilled;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const primary = sorted[0]!;
  const others = sorted.slice(1);

  const fieldDecisions: FieldMergeDecision[] = [];
  for (const field of CONTACT_FIELDS) {
    const primaryValue = (primary as Record<string, unknown>)[field];
    if (primaryValue != null) {
      fieldDecisions.push({ field, chosenValue: primaryValue, chosenFromId: primary.id, reason: "el registro primario ya tiene un valor real — nunca se sobrescribe" });
      continue;
    }
    const donor = others.find((o) => (o as Record<string, unknown>)[field] != null);
    if (donor) {
      fieldDecisions.push({
        field,
        chosenValue: (donor as Record<string, unknown>)[field],
        chosenFromId: donor.id,
        reason: "el primario no tenía este dato — se completa con el duplicado que sí lo tiene",
      });
    }
  }
  // Email verificado siempre gana, sin importar de cuál duplicado venga
  // — regla explícita del PO ("conservar siempre el dato de mayor
  // confianza"), un email VERIFIED nunca se descarta por un NOT_VERIFIED
  // del registro "primario".
  const verifiedDonor = [primary, ...others].find((c) => c.emailVerificationStatus === "VERIFIED");
  if (verifiedDonor && verifiedDonor.id !== primary.id) {
    fieldDecisions.push({
      field: "email (override por verificación)",
      chosenValue: verifiedDonor.email,
      chosenFromId: verifiedDonor.id,
      reason: "este duplicado tiene emailVerificationStatus=VERIFIED — gana sobre el email del primario aunque no sea el registro elegido como primario",
    });
  }

  return {
    entity: "Contact",
    matchType: group.matchType,
    matchKey: group.key,
    primaryId: primary.id,
    primaryReason: `confidenceScore=${primary.confidenceScore ?? "null"}, verificationStatus=${primary.verificationStatus}, emailVerificationStatus=${primary.emailVerificationStatus}`,
    duplicateIds: others.map((o) => o.id),
    fieldDecisions,
    reassignmentsNeeded: [], // Activity/FollowUp de un Contact son polimórficos por entityId — reasignación fuera de alcance de este plan, se documenta como limitación conocida, no se inventa un conteo
  };
}

export async function generateMergePlans(): Promise<MergePlanReport> {
  const duplicates = await generateDuplicatesReport();

  const companyGroups = [...duplicates.companies.byNameState, ...duplicates.companies.byWebsite];
  const contactGroups = [...duplicates.contacts.byEmail, ...duplicates.contacts.byLinkedin, ...duplicates.contacts.byNameCompany];

  const plans = await Promise.all([
    ...companyGroups.map((g) => planForCompanyGroup(g)),
    ...contactGroups.map((g) => planForContactGroup(g)),
  ]);

  return { generatedAt: new Date().toISOString(), plans };
}
