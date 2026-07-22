// F18: reporte de SOLO LECTURA de Companies cuya clasificación de
// industria probablemente sea incorrecta — auditoría pedida por el PO
// tras el hallazgo real de que candidatos de Data Centers (CoreSite,
// Equinix, Aligned, 360 Technology Center Solutions...) terminaron
// archivados como si fueran Hospitality en una misión de hoteles.
//
// Cero UPDATE/DELETE — el PO revisa este reporte primero y decide caso
// por caso qué reclasificar/eliminar (ver docs/F18_.../plan). Dos
// señales independientes, cualquiera de las dos marca la fila como
// sospechosa:
//
//   (a) classificationMode === "WEAK" en discoveryMetadata — la Company
//       se persistió sin ninguna evidencia positiva real de que el tipo
//       de negocio coincidiera con la industria a la que quedó archivada
//       (bug real, ver business-validation.ts/conversion-policy.ts).
//   (b) el nombre/sitio/notas contienen una palabra clave de OTRA
//       industria (ej. "data center" en una Company archivada como
//       Hospitality) — mismas negativeKeywords cruzadas ya agregadas a
//       taxonomy.ts como defensa en profundidad (mantenidas en sync acá
//       a mano; si taxonomy.ts cambia, actualizar este mapa).
//
// Uso:
//   node --import tsx packages/db/scripts/report-suspect-company-classifications.mjs \
//     [--tenant-id=tenant-titan] [--out=/path/al/reporte.json]

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = raw.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

// Espejo manual (a propósito, mismo criterio que illinois-backfill-lib.mjs
// duplicando lógica liviana en vez de importar TS entre paquetes) de las
// negativeKeywords cruzadas agregadas en
// apps/api/src/modules/ceo-intelligence/taxonomy.ts (F18). La clave es el
// nombre de la Industry real del CRM (Company.industry.name); el valor,
// palabras de OTRAS industrias que nunca deberían aparecer en el nombre/
// sitio/notas de una Company archivada ahí.
export const CROSS_INDUSTRY_KEYWORDS = {
  Hospitality: [
    "data center",
    "colocation",
    "critical facilities",
    "electrical contractor",
    "general contractor",
    "manufacturing plant",
    "distribution center",
    "industrial automation",
    "trucking company",
  ],
  Construction: ["hotel", "resort", "hospitality group"],
  Manufacturing: ["hotel", "resort"],
  "Warehouse/Logistics": ["hotel", "resort"],
};

function textOf(company) {
  return [company.name, company.website, company.notes].filter(Boolean).join(" ").toLowerCase();
}

export function findMatchedKeyword(company, industryName) {
  const keywords = CROSS_INDUSTRY_KEYWORDS[industryName];
  if (!keywords) return null;
  const haystack = textOf(company);
  return keywords.find((kw) => haystack.includes(kw.toLowerCase())) ?? null;
}

export function evaluateCompany(company) {
  const reasons = [];
  const meta = company.discoveryMetadata && typeof company.discoveryMetadata === "object" ? company.discoveryMetadata : null;
  const classificationMode = meta?.classificationMode ?? null;

  if (classificationMode === "WEAK") {
    reasons.push(`classificationMode=WEAK al momento del descubrimiento (sin evidencia positiva real de industria "${company.industry?.name ?? "?"}").`);
  }
  if (company.commercialStatus === "DISCOVERY_CANDIDATE") {
    reasons.push("commercialStatus=DISCOVERY_CANDIDATE -- ya marcada como candidato de Discovery sin validar (post-F18).");
  }
  const matchedKeyword = findMatchedKeyword(company, company.industry?.name ?? "");
  if (matchedKeyword) {
    reasons.push(`nombre/sitio/notas contienen "${matchedKeyword}", término típico de OTRA industria distinta de "${company.industry?.name ?? "?"}".`);
  }

  return { suspect: reasons.length > 0, reasons, classificationMode };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  let exitCode = 0;

  try {
    const companies = await prisma.company.findMany({
      where: args["tenant-id"] ? { tenantId: args["tenant-id"] } : undefined,
      include: { industry: true },
      orderBy: [{ industryId: "asc" }, { createdAt: "asc" }],
    });

    const flagged = [];
    for (const company of companies) {
      const evaluation = evaluateCompany(company);
      if (!evaluation.suspect) continue;
      flagged.push({
        id: company.id,
        name: company.name,
        industry: company.industry?.name ?? null,
        origin: company.origin,
        commercialStatus: company.commercialStatus,
        classificationMode: evaluation.classificationMode,
        website: company.website,
        city: company.city,
        state: company.state,
        discoveredAt: company.discoveredAt,
        reasons: evaluation.reasons,
      });
    }

    console.log(`Companies evaluadas: ${companies.length}`);
    console.log(`Companies sospechosas (revisar antes de reclasificar/eliminar): ${flagged.length}\n`);
    for (const row of flagged) {
      console.log(`- [${row.industry ?? "sin industria"}] ${row.name} (${row.id})`);
      for (const reason of row.reasons) console.log(`    · ${reason}`);
    }

    const outPath = args.out ?? `suspect-company-classifications-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), totalEvaluated: companies.length, flaggedCount: flagged.length, flagged }, null, 2));
    console.log(`\nReporte escrito en: ${outPath}`);
    console.log("SOLO LECTURA — cero UPDATE/DELETE. Ninguna Company fue modificada por este script.");
  } catch (err) {
    console.error("\nERROR durante el reporte:");
    console.error(err.message);
    exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
