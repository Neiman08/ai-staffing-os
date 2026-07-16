// Dry-run de solo lectura para la consolidación de las 75 Companies
// duplicadas creadas por la misión de Illinois (AgentTask raíz
// cmrljuyp5001ls7pqgql8lfh4). NUNCA ejecuta INSERT/UPDATE/DELETE, nunca
// abre una transacción de escritura — solo SELECT (vía Prisma findMany/
// count o $queryRaw de solo lectura). Ver docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md
// para el diseño completo.
//
// Uso: node --import tsx packages/db/scripts/dry-run-illinois-company-backfill.mjs
// (ejecutar desde packages/db, con DATABASE_URL cargado vía dotenv, igual
// que el resto de scripts de este repo)

import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

const EXPECTED_TENANT_ID = "tenant-titan";
const MISSION_TASK_ID = "cmrljuyp5001ls7pqgql8lfh4";
const EXPECTED_COMPANY_COUNT = 75;
// Corrección real encontrada al correr este script por primera vez: la
// suposición previa ("25 grupos, todos de tamaño 3") era imprecisa — no
// se verificó rigurosamente antes de esta corrida. El agrupamiento real
// por providerPlaceId, corroborado también por nombre normalizado (los
// dos coinciden en el 100% de los casos, sin conflicto), da 29 empresas
// reales distintas: 21 triplicadas (bug pleno, 3 pasadas), 4 duplicadas
// (solo 2 de las 3 pasadas del loop las volvieron a encontrar) y 4
// encontradas una sola vez (ninguna de las otras 2 pasadas las repitió
// — variación real de resultados de Google Places entre llamadas
// idénticas repetidas). No se fuerza un número fijo de grupos ni de
// tamaño — se valida la invariante real (suma de tamaños = 75) y se
// marca como advertencia, no bloqueo, cualquier grupo de tamaño 1 o 2
// (duplicación parcial, legítima, no es un error). Un grupo de tamaño
// > 3 sí bloquea — eso sería una sobre-duplicación nueva, no explicada
// por las 3 pasadas conocidas del loop.
const MAX_EXPECTED_GROUP_SIZE = 3;

let blockers = [];
let warnings = [];

function block(message, details) {
  blockers.push({ message, details: details ?? null });
}

function warn(message, details) {
  warnings.push({ message, details: details ?? null });
}

// ---------- Normalización (solo lectura/análisis — no es la corrección
// del pipeline real, que sigue pendiente y fuera de alcance de este
// script) ----------

const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "yourdomain.com", "domain.com", "email.com", "sentry.io", "wixpress.com"];
// Regex corregida respecto al bug real encontrado en website-intelligence/
// extract.ts: el local-part de un email NUNCA debe incluir "%" — ese es
// exactamente el carácter que dejaba pasar "%20press@equinix.com".
const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function normalizeEmail(raw) {
  if (!raw) return { value: null, valid: false, reason: "empty" };
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // decode inválido — seguimos con el crudo, la validación de sintaxis lo va a rechazar si corresponde
  }
  const cleaned = decoded.trim().toLowerCase().replace(/^["'<]+|["'>]+$/g, "");
  if (!EMAIL_RE.test(cleaned)) {
    return { value: null, valid: false, reason: "invalid_syntax", raw };
  }
  const domain = cleaned.split("@")[1];
  if (PLACEHOLDER_DOMAINS.includes(domain)) {
    return { value: null, valid: false, reason: "placeholder_domain", raw };
  }
  return { value: cleaned, valid: true, wasUrlEncoded: decoded !== raw };
}

function canonicalDomain(website) {
  if (!website) return null;
  try {
    const url = new URL(website);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

function canonicalizeWebsite(website) {
  if (!website) return null;
  try {
    const url = new URL(website);
    url.hash = "";
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key.toLowerCase() === "gclid" || key.toLowerCase() === "fbclid") {
        params.delete(key);
      }
    }
    url.search = params.toString();
    let pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.hostname}${pathname}${url.search}`;
  } catch {
    return website;
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // no se infiere código de país si no puede determinarse con seguridad
}

function normalizedNameKey(name, city, state) {
  const n = (name ?? "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|corp|corporation|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${n}|${(city ?? "").toLowerCase()}|${(state ?? "").toLowerCase()}`;
}

function extractProviderPlaceId(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    return url.searchParams.get("cid");
  } catch {
    return null;
  }
}

const CONTACT_POINT_TYPE_BY_PREFIX = [
  [/^info@/, "INFO"],
  [/^sales@/, "SALES"],
  [/^hr@/, "HR"],
  [/^(recruiting|recruiter)@/, "RECRUITING"],
  [/^(careers|jobs)@/, "CAREERS"],
  [/^support@/, "SUPPORT"],
  [/^(press|media)@/, "PRESS"],
  [/^(billing|accounting)@/, "BILLING"],
  [/^(purchasing|procurement)@/, "PROCUREMENT"],
];

function classifyContactPointType(email) {
  for (const [re, type] of CONTACT_POINT_TYPE_BY_PREFIX) {
    if (re.test(email)) return type;
  }
  return "OTHER";
}

// ---------- 1. Identificación de la misión (relacional, no por fecha) ----------

const missionTask = await prisma.agentTask.findUnique({
  where: { id: MISSION_TASK_ID },
  include: { agentInstance: { include: { definition: true } } },
});
if (!missionTask) {
  block("Mission task no encontrada", { MISSION_TASK_ID });
} else if (missionTask.agentInstance.definition.key !== "ceo" || missionTask.type !== "daily_revenue_mission") {
  block("La tarea encontrada no es la misión esperada", {
    agent: missionTask.agentInstance.definition.key,
    type: missionTask.type,
  });
}

const discoverTasks = missionTask
  ? await prisma.agentTask.findMany({
      where: { parentTaskId: MISSION_TASK_ID, type: "discover_companies" },
      include: { agentInstance: { include: { definition: true } } },
    })
  : [];
if (discoverTasks.length === 0) {
  block("No se encontraron discover_companies tasks hijas de la misión", { MISSION_TASK_ID });
}

const discoverTaskIds = discoverTasks.map((t) => t.id);

// ---------- 2. Companies de la cohorte (por discoveredByAgentTaskId — fuerte, relacional) ----------

const companies = await prisma.company.findMany({
  where: { discoveredByAgentTaskId: { in: discoverTaskIds } },
  orderBy: { createdAt: "asc" },
});

// Corroboración secundaria: ventana temporal + tenant + origin (nunca la
// identificación primaria, solo validación de consistencia).
const start = new Date("2026-07-15T03:57:00.000Z");
const end = new Date("2026-07-15T04:04:00.000Z");
const outsideWindow = companies.filter((c) => c.createdAt < start || c.createdAt > end);
if (outsideWindow.length > 0) {
  warn("Companies encontradas por relación pero fuera de la ventana temporal esperada", {
    ids: outsideWindow.map((c) => c.id),
  });
}

if (companies.length !== EXPECTED_COMPANY_COUNT) {
  block(`Se esperaban exactamente ${EXPECTED_COMPANY_COUNT} Companies, se encontraron ${companies.length}`, {
    found: companies.length,
  });
}

const wrongTenant = companies.filter((c) => c.tenantId !== EXPECTED_TENANT_ID);
if (wrongTenant.length > 0) {
  block("Companies de un tenant distinto al esperado", { ids: wrongTenant.map((c) => c.id), expected: EXPECTED_TENANT_ID });
}

if (blockers.length > 0) {
  console.error("BLOCKERS detectados antes de agrupar — deteniendo sin escribir nada.");
  console.error(JSON.stringify({ blockers, warnings }, null, 2));
  await prisma.$disconnect();
  process.exit(1);
}

// ---------- 3. Relaciones reales por Company (auditoría, solo lectura) ----------

const companyIds = companies.map((c) => c.id);
const [leads, contacts, opportunities, campaignCompanies, jobOrders, projects, invoices, contracts, companyActivities] =
  await Promise.all([
    prisma.lead.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.contact.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.opportunity.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.campaignCompany.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.jobOrder.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.project.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.invoice.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.contract.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.activity.findMany({ where: { entityType: "company", entityId: { in: companyIds } } }),
  ]);

const leadIds = leads.map((l) => l.id);
const leadActivities = await prisma.activity.findMany({ where: { entityType: "lead", entityId: { in: leadIds } } });

const relationsByCompany = new Map(companyIds.map((id) => [id, { leads: 0, contacts: 0, opportunities: 0, campaignCompanies: 0, jobOrders: 0, projects: 0, invoices: 0, contracts: 0, activities: 0 }]));
for (const l of leads) relationsByCompany.get(l.companyId).leads++;
for (const c of contacts) relationsByCompany.get(c.companyId).contacts++;
for (const o of opportunities) relationsByCompany.get(o.companyId).opportunities++;
for (const cc of campaignCompanies) relationsByCompany.get(cc.companyId).campaignCompanies++;
for (const j of jobOrders) relationsByCompany.get(j.companyId).jobOrders++;
for (const pr of projects) relationsByCompany.get(pr.companyId).projects++;
for (const inv of invoices) relationsByCompany.get(inv.companyId).invoices++;
for (const ct of contracts) relationsByCompany.get(ct.companyId).contracts++;
for (const a of companyActivities) relationsByCompany.get(a.entityId).activities++;

// ---------- 4. Agrupación — providerPlaceId como clave primaria ----------

const groupsByPlaceId = new Map();
for (const c of companies) {
  const placeId = extractProviderPlaceId(c.sourceUrl);
  if (!placeId) {
    block("Company sin providerPlaceId extraíble de sourceUrl", { companyId: c.id, sourceUrl: c.sourceUrl });
    continue;
  }
  if (!groupsByPlaceId.has(placeId)) groupsByPlaceId.set(placeId, []);
  groupsByPlaceId.get(placeId).push(c);
}

// Invariante dura: la suma de tamaños de todos los grupos debe ser
// exactamente igual al total de Companies encontradas — si no, hay
// providerPlaceIds duplicados incorrectamente contados o una Company
// perdida en el agrupamiento (bug del script, no del dato).
const totalGrouped = [...groupsByPlaceId.values()].reduce((sum, rows) => sum + rows.length, 0);
if (totalGrouped !== companies.length) {
  block("La suma de tamaños de grupo no coincide con el total de Companies — posible bug de agrupamiento", {
    totalGrouped,
    totalCompanies: companies.length,
  });
}

// Sobre-duplicación inesperada (más de las 3 pasadas conocidas del loop
// per-industria) SÍ bloquea — sería una anomalía nueva, no explicada.
const overSizedGroups = [...groupsByPlaceId.entries()].filter(([, rows]) => rows.length > MAX_EXPECTED_GROUP_SIZE);
if (overSizedGroups.length > 0) {
  block(`Grupos con más de ${MAX_EXPECTED_GROUP_SIZE} filas — sobre-duplicación no explicada por el bug conocido`, {
    groups: overSizedGroups.map(([placeId, rows]) => ({ placeId, size: rows.length, ids: rows.map((r) => r.id) })),
  });
}

// Duplicación parcial (tamaño 1 o 2) es legítima y esperada — Google
// Places no siempre repite el mismo resultado en 3 llamadas idénticas
// consecutivas. Se reporta como advertencia informativa, nunca bloquea.
const groupSizeDistribution = {};
for (const rows of groupsByPlaceId.values()) {
  groupSizeDistribution[rows.length] = (groupSizeDistribution[rows.length] ?? 0) + 1;
}
warn("Distribución real de tamaños de grupo (informativo, no bloqueante)", {
  distribution: groupSizeDistribution,
  totalGroups: groupsByPlaceId.size,
  note: "1 = ya es canónica, sin duplicados que fusionar. 2 = duplicación parcial (2 de las 3 pasadas). 3 = duplicación completa (bug pleno, las 3 pasadas).",
});

// Validación cruzada por claves secundarias (nunca primaria) — un grupo
// cuyo providerPlaceId coincide pero cuyo canonicalDomain diverge
// fuertemente es sospechoso de una fusión falsa (mismo cid reutilizado
// por Google para dos negocios distintos, caso límite no observado en
// esta cohorte pero contemplado).
for (const [placeId, rows] of groupsByPlaceId) {
  const domains = new Set(rows.map((r) => canonicalDomain(r.website)).filter(Boolean));
  if (domains.size > 1) {
    warn("Grupo con el mismo providerPlaceId pero canonicalDomain distinto — revisar antes de confiar en el merge automático", {
      placeId,
      domains: [...domains],
      ids: rows.map((r) => r.id),
    });
  }
  const phones = new Set(rows.map((r) => normalizePhone(r.phone)).filter(Boolean));
  if (phones.size > 1) {
    warn("Grupo con el mismo providerPlaceId pero teléfono normalizado distinto", { placeId, phones: [...phones] });
  }
  const nameKeys = new Set(rows.map((r) => normalizedNameKey(r.name, r.city, r.state)));
  if (nameKeys.size > 1) {
    warn("Grupo con el mismo providerPlaceId pero nombre normalizado + ciudad/estado distinto", { placeId, nameKeys: [...nameKeys] });
  }
}

if (blockers.length > 0) {
  console.error("BLOCKERS detectados al agrupar — deteniendo sin escribir nada.");
  console.error(JSON.stringify({ blockers, warnings }, null, 2));
  await prisma.$disconnect();
  process.exit(1);
}

// ---------- 5. Completeness score + elección de canonical por grupo ----------

function completenessScore(company) {
  let score = 0;
  const reasons = [];
  if (company.website) { score += 2; reasons.push("website:+2"); }
  if (company.phone) { score += 2; reasons.push("phone:+2"); }
  if (company.email) {
    score += 1;
    reasons.push("email_present:+1");
    if (normalizeEmail(company.email).valid) { score += 1; reasons.push("email_valid:+1"); }
  }
  if (company.address) { score += 1; reasons.push("address:+1"); }
  if (company.verificationStatus !== "UNVERIFIED") { score += 2; reasons.push("verificationStatus:+2"); }
  if (company.confidenceScore) { const pts = Math.round(company.confidenceScore * 2); score += pts; reasons.push(`confidenceScore:+${pts}`); }
  const rel = relationsByCompany.get(company.id);
  const relPts = Object.values(rel).filter((n) => n > 0).length;
  score += relPts;
  reasons.push(`relations_present:+${relPts}`);
  return { score, reasons };
}

const groupReports = [];
for (const [placeId, rows] of groupsByPlaceId) {
  const scored = rows.map((c) => ({ company: c, ...completenessScore(c) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.company.createdAt.getTime() - b.company.createdAt.getTime(); // desempate: más antigua
  });
  const canonical = scored[0];
  const duplicates = scored.slice(1);

  const originalIndustryIds = [...new Set(rows.map((r) => r.industryId))];
  const searchTermsFromTask = discoverTasks
    .filter((t) => t.id === canonical.company.discoveredByAgentTaskId)
    .map((t) => t.input?.searchTerms ?? [])
    .flat();

  const emailsInGroup = [...new Set(rows.map((r) => r.email).filter(Boolean))];
  const contactPointProposals = emailsInGroup
    .map((raw) => ({ raw, normalized: normalizeEmail(raw) }))
    .filter((e) => e.normalized.valid)
    .map((e) => ({
      email: e.normalized.value,
      wasUrlEncoded: e.normalized.wasUrlEncoded ?? false,
      type: classifyContactPointType(e.normalized.value),
      discoveryProvider: "Website Intelligence (o Hunter.io, no distinguible retroactivamente en Company.email — ver limitación documentada)",
      sourceUrl: canonical.company.sourceUrl,
      verificationStatus: "NOT_VERIFIED",
    }));
  const rejectedEmails = rows
    .map((r) => r.email)
    .filter(Boolean)
    .map((raw) => ({ raw, ...normalizeEmail(raw) }))
    .filter((e) => !e.valid);

  const proposedDiscoveryMetadata = {
    schemaVersion: 1,
    searchTermsMatched: searchTermsFromTask,
    providerBusinessTypes: [], // gap real confirmado: Google Places "types" se pide pero nunca se mapea en extractFieldsFromGooglePlace — no hay señal que reconstruir retroactivamente
    detectedBusinessType: null,
    detectedSector: null,
    crmIndustryId: canonical.company.industryId,
    crmIndustryName: null, // se completa en el documento con el nombre real de Industry al momento de escribir
    classificationMode: "FALLBACK",
    classificationConfidence: null,
    classificationReason:
      "Retenida del bug de iteración por industria (mission-orchestrator.ts) — no hay evidencia suficiente para reclasificar con confianza en este backfill retroactivo; la corrección real de clasificación queda para la corrección del pipeline (fuera de alcance de este backfill).",
    providerPlaceId: placeId,
    canonicalDomain: canonicalDomain(canonical.company.website),
    originalWebsite: canonical.company.website,
    canonicalWebsite: canonicalizeWebsite(canonical.company.website),
    originalPhone: canonical.company.phone,
    normalizedPhone: normalizePhone(canonical.company.phone),
    discoveredAt: canonical.company.discoveredAt ?? canonical.company.createdAt,
    lastUpdatedAt: new Date().toISOString(),
    mergedFromCompanyIds: duplicates.map((d) => d.company.id),
    originalIndustryIds,
  };

  // Leads: selección independiente por su propio score (aiScore desc,
  // createdAt asc), no necesariamente el de la Company canonical elegida.
  const groupLeads = leads.filter((l) => rows.some((r) => r.id === l.companyId));
  const sortedLeads = [...groupLeads].sort((a, b) => {
    const scoreA = a.aiScore ?? -1;
    const scoreB = b.aiScore ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const survivingLead = sortedLeads[0] ?? null;
  const leadsToRemove = sortedLeads.slice(1);

  groupReports.push({
    providerPlaceId: placeId,
    canonicalCompanyId: canonical.company.id,
    canonicalName: canonical.company.name,
    canonicalScore: canonical.score,
    canonicalScoreReasons: canonical.reasons,
    duplicateCompanyIds: duplicates.map((d) => d.company.id),
    duplicateScores: duplicates.map((d) => ({ id: d.company.id, score: d.score })),
    selectionReason:
      duplicates.length && duplicates[0].score === canonical.score
        ? "empate de completeness score — desempatada por createdAt más antigua"
        : "mayor completeness score",
    originalIndustryIds,
    proposedDiscoveryMetadata,
    contactPointProposals,
    rejectedEmails,
    survivingLeadId: survivingLead?.id ?? null,
    survivingLeadCompanyId: survivingLead?.companyId ?? null,
    needsLeadCompanyReassignment: survivingLead ? survivingLead.companyId !== canonical.company.id : false,
    leadIdsToRemove: leadsToRemove.map((l) => l.id),
    leadActivityIdsToReassign: leadActivities.filter((a) => leadsToRemove.some((l) => l.id === a.entityId)).map((a) => a.id),
    companyActivityIdsToReassign: companyActivities.filter((a) => rows.some((r) => r.id === a.entityId) && a.entityId !== canonical.company.id).map((a) => a.id),
  });
}

// ---------- 6. Snapshot hash (para que la ejecución futura se niegue si algo cambió) ----------

const snapshotInput = companies
  .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
  .sort((a, b) => a.id.localeCompare(b.id));
const snapshotHash = createHash("sha256").update(JSON.stringify(snapshotInput)).digest("hex");

// ---------- 7. Conteos esperados antes/después ----------

const expectedBeforeAfter = {
  companiesBefore: companies.length,
  companiesAfter: groupsByPlaceId.size,
  companiesToDelete: companies.length - groupsByPlaceId.size,
  leadsBefore: leads.length,
  leadsAfter: groupReports.filter((g) => g.survivingLeadId).length,
  leadsToDelete: groupReports.reduce((sum, g) => sum + g.leadIdsToRemove.length, 0),
  companyContactPointsToCreate: groupReports.reduce((sum, g) => sum + g.contactPointProposals.length, 0),
  contactsAffected: contacts.length, // esperado: 0 en esta cohorte
  opportunitiesAffected: opportunities.length, // esperado: 0
  campaignCompaniesAffected: campaignCompanies.length, // esperado: 0
  jobOrdersAffected: jobOrders.length, // esperado: 0
  projectsAffected: projects.length, // esperado: 0
  invoicesAffected: invoices.length, // esperado: 0
  contractsAffected: contracts.length, // esperado: 0
  companyActivitiesToReassign: groupReports.reduce((sum, g) => sum + g.companyActivityIdsToReassign.length, 0),
  leadActivitiesToReassign: groupReports.reduce((sum, g) => sum + g.leadActivityIdsToReassign.length, 0),
};

// ---------- 8. Salida ----------

const report = {
  generatedAt: new Date().toISOString(),
  tenantId: EXPECTED_TENANT_ID,
  missionTaskId: MISSION_TASK_ID,
  discoverTaskIds,
  snapshotHash,
  companiesFound: companies.length,
  groupsFound: groupsByPlaceId.size,
  groups: groupReports,
  expectedBeforeAfter,
  blockers,
  warnings,
  readOnlyConfirmation: "Este script no ejecutó ningún INSERT/UPDATE/DELETE. Cero llamadas a proveedores externos (Google Places/Hunter/PDL).",
};

console.log(JSON.stringify(report, null, 2));

if (blockers.length > 0) {
  console.error(`\n${blockers.length} blocker(s) encontrados — la ejecución real NO debe proceder.`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\nOK — ${groupsByPlaceId.size} grupos válidos (tamaño máx. ${MAX_EXPECTED_GROUP_SIZE}), snapshotHash=${snapshotHash}`);
console.log(`${warnings.length} warning(s) no bloqueante(s).`);
await prisma.$disconnect();
process.exit(0);
