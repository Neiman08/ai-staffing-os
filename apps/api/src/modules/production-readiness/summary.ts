import { scopedDb } from "../../core/tenancy/prisma-extension";
import { classifyAllRecords } from "./classify-all";
import { generateDuplicatesReport } from "./duplicates";
import { computeCompanyQualityScore, computeContactQualityScore } from "./data-quality";
import { isProductionMode } from "../../core/production-mode";

export interface ProductionReadinessSummary {
  generatedAt: string;
  productionMode: boolean;
  companies: { real: number; demo: number; incomplete: number; avgQualityScore: number };
  contacts: { real: number; demo: number; incomplete: number; avgQualityScore: number; emailsVerified: number };
  duplicates: { groups: number; affectedRecords: number };
  readiness: {
    dataQualityComponent: number; // 0-100
    duplicatesComponent: number; // 0-100
    percentReady: number; // 0-100, promedio de los dos de arriba — ver docstring
  };
}

const INCOMPLETE_THRESHOLD = 0.5;

/**
 * F4.7.5 §7: agregación real para el panel "Production Readiness" — de
 * solo lectura. `readiness.percentReady` es deliberadamente simple y
 * transparente (promedio de dos componentes explícitos, ambos también
 * expuestos por separado) — no es un puntaje "mágico", es una señal
 * operativa para decidir cuándo pedir aprobación de Production Mode,
 * nunca se presenta como una certeza matemática.
 */
export async function generateProductionReadinessSummary(): Promise<ProductionReadinessSummary> {
  const [records, duplicates, companyRows, contactRows] = await Promise.all([
    classifyAllRecords(),
    generateDuplicatesReport(),
    scopedDb.company.findMany({
      select: { id: true, website: true, phone: true, city: true, state: true, email: true, origin: true, updatedAt: true, confidenceScore: true },
    }),
    scopedDb.contact.findMany({
      select: {
        id: true,
        email: true,
        emailVerificationStatus: true,
        phone: true,
        linkedinUrl: true,
        source: true,
        discoveredAt: true,
        emailVerifiedAt: true,
        createdAt: true,
        confidenceScore: true,
      },
    }),
  ]);

  const companyOriginById = new Map(records.companies.map((c) => [c.id, c.origin]));
  const contactOriginById = new Map(records.contacts.map((c) => [c.id, c.origin]));

  const realCompanyRows = companyRows.filter((c) => companyOriginById.get(c.id) !== "DEMO");
  const demoCompanyCount = companyRows.length - realCompanyRows.length;
  const companyScores = realCompanyRows.map((c) => computeCompanyQualityScore(c).score);
  const companiesIncomplete = companyScores.filter((s) => s < INCOMPLETE_THRESHOLD).length;
  const companiesAvgQuality = companyScores.length ? companyScores.reduce((a, b) => a + b, 0) / companyScores.length : 0;

  const realContactRows = contactRows.filter((c) => contactOriginById.get(c.id) !== "DEMO");
  const demoContactCount = contactRows.length - realContactRows.length;
  const contactScores = realContactRows.map((c) => computeContactQualityScore(c).score);
  const contactsIncomplete = contactScores.filter((s) => s < INCOMPLETE_THRESHOLD).length;
  const contactsAvgQuality = contactScores.length ? contactScores.reduce((a, b) => a + b, 0) / contactScores.length : 0;
  const emailsVerified = realContactRows.filter((c) => c.emailVerificationStatus === "VERIFIED").length;

  const totalRealRecords = realCompanyRows.length + realContactRows.length;
  const dataQualityComponent = totalRealRecords
    ? ((companiesAvgQuality * realCompanyRows.length + contactsAvgQuality * realContactRows.length) / totalRealRecords) * 100
    : 0;
  const duplicatesComponent = totalRealRecords
    ? Math.max(0, 100 - (duplicates.summary.totalAffectedRecords / totalRealRecords) * 100)
    : 100;

  return {
    generatedAt: new Date().toISOString(),
    productionMode: isProductionMode(),
    companies: {
      real: realCompanyRows.length,
      demo: demoCompanyCount,
      incomplete: companiesIncomplete,
      avgQualityScore: companiesAvgQuality,
    },
    contacts: {
      real: realContactRows.length,
      demo: demoContactCount,
      incomplete: contactsIncomplete,
      avgQualityScore: contactsAvgQuality,
      emailsVerified,
    },
    duplicates: { groups: duplicates.summary.totalDuplicateGroups, affectedRecords: duplicates.summary.totalAffectedRecords },
    readiness: {
      dataQualityComponent,
      duplicatesComponent,
      percentReady: (dataQualityComponent + duplicatesComponent) / 2,
    },
  };
}
