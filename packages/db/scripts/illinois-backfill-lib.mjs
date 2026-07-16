// Lógica compartida entre el dry-run, el script de ejecución real y sus
// tests — funciones puras (sin DB) + helpers que reciben un cliente
// Prisma ya conectado por parámetro (nunca instancian uno propio, para
// que los tests puedan pasar cualquier cliente, real o de un fixture
// desechable). Ver docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md para el diseño.

import { createHash } from "node:crypto";

// ---------- Normalización (idéntica a la usada en el dry-run) ----------

export const PLACEHOLDER_DOMAINS = ["example.com", "example.org", "yourdomain.com", "domain.com", "email.com", "sentry.io", "wixpress.com"];
// Regex corregida respecto al bug real de website-intelligence/extract.ts:
// el local-part de un email NUNCA debe incluir "%".
export const EMAIL_RE = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function normalizeEmail(raw) {
  if (!raw) return { value: null, valid: false, reason: "empty" };
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // decode inválido — seguimos con el crudo, la validación de sintaxis lo rechaza si corresponde
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

export function canonicalDomain(website) {
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

export function canonicalizeWebsite(website) {
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
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.hostname}${pathname}${url.search}`;
  } catch {
    return website;
  }
}

export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function normalizedNameKey(name, city, state) {
  const n = (name ?? "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|corp|corporation|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${n}|${(city ?? "").toLowerCase()}|${(state ?? "").toLowerCase()}`;
}

export function extractProviderPlaceId(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).searchParams.get("cid");
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

export function classifyContactPointType(email) {
  for (const [re, type] of CONTACT_POINT_TYPE_BY_PREFIX) {
    if (re.test(email)) return type;
  }
  return "OTHER";
}

// ---------- Snapshot hash — misma lógica exacta que el dry-run, para que
// el hash recalculado en la ejecución real sea comparable byte a byte ----------

export function computeSnapshotHash(companies) {
  const snapshotInput = companies
    .map((c) => ({
      id: c.id,
      name: c.name,
      website: c.website,
      phone: c.phone,
      email: c.email,
      sourceUrl: c.sourceUrl,
      industryId: c.industryId,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(snapshotInput)).digest("hex");
}

// Diferencia campo a campo entre el snapshot aprobado (pinned) y el estado
// actual — se usa solo para armar un mensaje de error útil cuando el hash
// no coincide, nunca para decidir si continuar (esa decisión la toma
// exclusivamente la comparación de hash completa).
export function diffCompanySnapshots(approvedSnapshot, currentCompanies) {
  const approvedById = new Map(approvedSnapshot.map((c) => [c.id, c]));
  const currentById = new Map(
    currentCompanies.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        website: c.website,
        phone: c.phone,
        email: c.email,
        sourceUrl: c.sourceUrl,
        industryId: c.industryId,
        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      },
    ]),
  );
  const differences = [];
  for (const [id, approved] of approvedById) {
    const current = currentById.get(id);
    if (!current) {
      differences.push({ id, issue: "missing_in_current" });
      continue;
    }
    for (const key of Object.keys(approved)) {
      if (approved[key] !== current[key]) {
        differences.push({ id, issue: "field_changed", field: key, approved: approved[key], current: current[key] });
      }
    }
  }
  for (const id of currentById.keys()) {
    if (!approvedById.has(id)) differences.push({ id, issue: "unexpected_new_row" });
  }
  return differences;
}

// ---------- Validación de guards — pura, recibe conteos ya obtenidos ----------

export function buildGuardReport(actual, expected) {
  const failures = [];
  const checks = [
    ["tenantId", actual.tenantId, expected.tenantId],
    ["missionTaskId", actual.missionTaskId, expected.missionTaskId],
    ["snapshotHash", actual.snapshotHash, expected.snapshotHash],
    ["companiesCount", actual.companiesCount, expected.companiesCount],
    ["groupsCount", actual.groupsCount, expected.groupsCount],
    ["companyDeletesCount", actual.companyDeletesCount, expected.companyDeletesCount],
    ["leadsCount", actual.leadsCount, expected.leadsCount],
    ["leadDeletesCount", actual.leadDeletesCount, expected.leadDeletesCount],
    ["contactPointsCount", actual.contactPointsCount, expected.contactPointsCount],
    ["existingContactPointsForCohort", actual.existingContactPointsForCohort, 0],
    ["companiesWithNonNullDiscoveryMetadata", actual.companiesWithNonNullDiscoveryMetadata, 0],
    ["unexpectedRelationRows", actual.unexpectedRelationRows, 0],
  ];
  for (const [name, act, exp] of checks) {
    if (act !== exp) failures.push({ check: name, expected: exp, actual: act });
  }
  return { ok: failures.length === 0, failures };
}

// ---------- Carga de datos (usa un prisma client inyectado — nunca crea uno propio) ----------

export async function loadCohort(prisma, discoverTaskIds) {
  return prisma.company.findMany({
    where: { discoveredByAgentTaskId: { in: discoverTaskIds } },
    orderBy: { createdAt: "asc" },
  });
}

export async function loadRelationCounts(prisma, companyIds) {
  const [contacts, opportunities, campaignCompanies, jobOrders, projects, invoices, contracts] = await Promise.all([
    prisma.contact.count({ where: { companyId: { in: companyIds } } }),
    prisma.opportunity.count({ where: { companyId: { in: companyIds } } }),
    prisma.campaignCompany.count({ where: { companyId: { in: companyIds } } }),
    prisma.jobOrder.count({ where: { companyId: { in: companyIds } } }),
    prisma.project.count({ where: { companyId: { in: companyIds } } }),
    prisma.invoice.count({ where: { companyId: { in: companyIds } } }),
    prisma.contract.count({ where: { companyId: { in: companyIds } } }),
  ]);
  return { contacts, opportunities, campaignCompanies, jobOrders, projects, invoices, contracts };
}

export function sumUnexpectedRelations(relationCounts) {
  return Object.values(relationCounts).reduce((sum, n) => sum + n, 0);
}
