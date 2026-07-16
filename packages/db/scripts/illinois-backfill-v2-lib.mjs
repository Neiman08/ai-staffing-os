// Extensión de illinois-backfill-lib.mjs / illinois-stabilization-lib.mjs
// para el snapshot v2 del backfill de Illinois — incorpora las 16
// Opportunities y las 75 AgentMemory (creadas por el prospecting-pipeline
// real y por la estabilización de Opción C) que no existían cuando se
// congeló el snapshot v1. Funciones puras + helpers de carga (reciben un
// cliente Prisma ya conectado por parámetro, nunca instancian uno
// propio). Ver docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md §14 para el diseño
// completo de esta revisión.

import { createHash } from "node:crypto";

export const STABILIZATION_MARKER = "illinois-backfill-stabilization";

export function classifyMemory(memory) {
  return memory.content.includes(STABILIZATION_MARKER) ? "stabilization" : "real";
}

export async function loadLeadsForCompanies(prisma, companyIds) {
  if (companyIds.length === 0) return [];
  return prisma.lead.findMany({ where: { companyId: { in: companyIds } }, orderBy: { createdAt: "asc" } });
}

export async function loadOpportunitiesForCompanies(prisma, companyIds) {
  if (companyIds.length === 0) return [];
  return prisma.opportunity.findMany({ where: { companyId: { in: companyIds } }, orderBy: { createdAt: "asc" } });
}

export async function loadActivitiesForEntity(prisma, entityType, entityIds) {
  if (entityIds.length === 0) return [];
  return prisma.activity.findMany({ where: { entityType, entityId: { in: entityIds } }, orderBy: { createdAt: "asc" } });
}

export async function loadFollowUpsForEntity(prisma, entityType, entityIds) {
  if (entityIds.length === 0) return [];
  return prisma.followUp.findMany({ where: { entityType, entityId: { in: entityIds } }, orderBy: { createdAt: "asc" } });
}

export async function loadCompanyMemories(prisma, companyIds) {
  if (companyIds.length === 0) return [];
  return prisma.agentMemory.findMany({ where: { entityType: "company", entityId: { in: companyIds } }, orderBy: { createdAt: "asc" } });
}

/**
 * Clasifica Leads en mission (source="external-discovery-mission") vs
 * pipeline (source="prospecting-pipeline") y los agrupa por
 * canonical/duplicate según el mapping ya aprobado (nunca recomputado).
 */
export function classifyLeads(leads, canonicalIdSet, duplicateIdSet) {
  const missionLeads = leads.filter((l) => l.source === "external-discovery-mission");
  const pipelineLeads = leads.filter((l) => l.source === "prospecting-pipeline");
  const otherLeads = leads.filter((l) => l.source !== "external-discovery-mission" && l.source !== "prospecting-pipeline");
  return {
    missionLeadsOnCanonical: missionLeads.filter((l) => canonicalIdSet.has(l.companyId)),
    missionLeadsOnDuplicate: missionLeads.filter((l) => duplicateIdSet.has(l.companyId)),
    pipelineLeadsOnCanonical: pipelineLeads.filter((l) => canonicalIdSet.has(l.companyId)),
    pipelineLeadsOnDuplicate: pipelineLeads.filter((l) => duplicateIdSet.has(l.companyId)),
    otherLeads,
  };
}

/**
 * Clasifica Opportunities por canonical/duplicate y detecta conflictos
 * (más de una Opportunity en la misma Company) — nunca decide fusionar
 * ni eliminar, solo reporta para que un humano decida si aparece.
 */
export function classifyOpportunities(opportunities, canonicalIdSet, duplicateIdSet) {
  const onCanonical = opportunities.filter((o) => canonicalIdSet.has(o.companyId));
  const onDuplicate = opportunities.filter((o) => duplicateIdSet.has(o.companyId));
  const onUnknown = opportunities.filter((o) => !canonicalIdSet.has(o.companyId) && !duplicateIdSet.has(o.companyId));

  const byCompany = new Map();
  for (const o of opportunities) {
    if (!byCompany.has(o.companyId)) byCompany.set(o.companyId, []);
    byCompany.get(o.companyId).push(o);
  }
  const multiplePerCompany = [...byCompany.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([companyId, list]) => ({ companyId, opportunityIds: list.map((o) => o.id) }));

  return { onCanonical, onDuplicate, onUnknown, multiplePerCompany };
}

/**
 * Para cada AgentMemory de la cohorte, decide si debe:
 * - "keep": está en una Company canónica, no se toca.
 * - "delete": está en una Company duplicada Y la canónica de su grupo ya
 *   tiene su propia AgentMemory (cobertura ya garantizada) — se elimina
 *   junto con la Company duplicada, sin dejar entityId colgante.
 * - "reassign": está en una Company duplicada Y la canónica de su grupo
 *   TODAVÍA no tiene ninguna AgentMemory — se reasigna (UPDATE entityId)
 *   en vez de eliminarse, para no perder la cobertura de bloqueo del
 *   scheduler sobre la canónica.
 *
 * Nunca crea una segunda memoria en una canónica ya cubierta (evita
 * duplicados lógicos).
 */
export function planAgentMemoryActions(memories, groups) {
  const canonicalByDuplicateId = new Map();
  for (const g of groups) {
    for (const dupId of g.duplicateCompanyIds) canonicalByDuplicateId.set(dupId, g.canonicalCompanyId);
  }
  const canonicalIdSet = new Set(groups.map((g) => g.canonicalCompanyId));

  const memoriesByEntity = new Map();
  for (const m of memories) {
    if (!memoriesByEntity.has(m.entityId)) memoriesByEntity.set(m.entityId, []);
    memoriesByEntity.get(m.entityId).push(m);
  }

  const actions = [];
  // Se procesan canónicas primero para saber, al llegar a cada
  // duplicada, si su canónica ya está cubierta.
  const canonicalCovered = new Set([...canonicalIdSet].filter((id) => (memoriesByEntity.get(id) ?? []).length > 0));

  for (const m of memories) {
    if (canonicalIdSet.has(m.entityId)) {
      actions.push({ memoryId: m.id, entityId: m.entityId, kind: classifyMemory(m), action: "keep" });
      continue;
    }
    const canonicalId = canonicalByDuplicateId.get(m.entityId);
    if (!canonicalId) {
      actions.push({ memoryId: m.id, entityId: m.entityId, kind: classifyMemory(m), action: "unknown_company" });
      continue;
    }
    if (canonicalCovered.has(canonicalId)) {
      actions.push({ memoryId: m.id, entityId: m.entityId, kind: classifyMemory(m), action: "delete", canonicalId });
    } else {
      actions.push({ memoryId: m.id, entityId: m.entityId, kind: classifyMemory(m), action: "reassign", canonicalId });
      canonicalCovered.add(canonicalId); // la canónica queda cubierta por esta reasignación para las siguientes duplicadas del mismo grupo
    }
  }
  return actions;
}

/**
 * Clasifica Activities (entityType="company"|"lead"|"opportunity") en
 * "reassign" (su entityId pertenece a algo que va a eliminarse/cambiar
 * de id) vs "unchanged".
 */
export function classifyActivitiesByCompany(activities, duplicateIdSet) {
  return {
    onDuplicate: activities.filter((a) => duplicateIdSet.has(a.entityId)),
    unchanged: activities.filter((a) => !duplicateIdSet.has(a.entityId)),
  };
}

export function classifyActivitiesByLead(activities, leadsById, duplicateIdSet) {
  const onDuplicateLead = activities.filter((a) => {
    const lead = leadsById.get(a.entityId);
    return lead && duplicateIdSet.has(lead.companyId);
  });
  const unchanged = activities.filter((a) => {
    const lead = leadsById.get(a.entityId);
    return !lead || !duplicateIdSet.has(lead.companyId);
  });
  return { onDuplicateLead, unchanged };
}

// Guard genérico para la ejecución real v2 — mismo patrón que
// buildGuardReport() en illinois-backfill-lib.mjs (v1), pero con la
// lista de campos ampliada para cubrir Opportunities/AgentMemory/
// Activities/FollowUps. Se mantiene como función propia (no se
// modifica la de v1) para no alterar el script v1 ya probado.
export function buildGuardReportV2(actual, expected) {
  const failures = [];
  const checks = [
    ["tenantId", actual.tenantId, expected.tenantId],
    ["missionTaskId", actual.missionTaskId, expected.missionTaskId],
    ["snapshotHash", actual.snapshotHash, expected.snapshotHash],
    ["companiesCount", actual.companiesCount, expected.companiesCount],
    ["groupsCount", actual.groupsCount, expected.groupsCount],
    ["companyDeletesCount", actual.companyDeletesCount, expected.companyDeletesCount],
    ["leadsCount", actual.leadsCount, expected.leadsCount],
    ["leadsFinalCount", actual.leadsFinalCount, expected.leadsFinalCount],
    ["leadDeletesCount", actual.leadDeletesCount, expected.leadDeletesCount],
    ["opportunitiesCount", actual.opportunitiesCount, expected.opportunitiesCount],
    ["opportunitiesReassignCount", actual.opportunitiesReassignCount, expected.opportunitiesReassignCount],
    ["memoriesCount", actual.memoriesCount, expected.memoriesCount],
    ["memoriesDeleteCount", actual.memoriesDeleteCount, expected.memoriesDeleteCount],
    ["memoriesReassignCount", actual.memoriesReassignCount, expected.memoriesReassignCount],
    ["activitiesReassignCount", actual.activitiesReassignCount, expected.activitiesReassignCount],
    ["followUpsReassignCount", actual.followUpsReassignCount, expected.followUpsReassignCount],
    ["contactPointsCount", actual.contactPointsCount, expected.contactPointsCount],
    ["existingContactPointsForCohort", actual.existingContactPointsForCohort, 0],
    ["companiesWithNonNullDiscoveryMetadata", actual.companiesWithNonNullDiscoveryMetadata, 0],
  ];
  for (const [name, act, exp] of checks) {
    if (act !== exp) failures.push({ check: name, expected: exp, actual: act });
  }
  return { ok: failures.length === 0, failures };
}

// Snapshot hash extendido — cubre Companies + Leads + Opportunities +
// Activities (company/lead/opportunity) + FollowUps + AgentMemory +
// conteos de CompanyContactPoint/discoveryMetadata existentes. Cualquier
// cambio en cualquiera de estas entidades desde que se generó el
// snapshot invalida el hash.
export function computeExtendedSnapshotHash({
  companies,
  leads,
  opportunities,
  activitiesCompany,
  activitiesLead,
  activitiesOpportunity,
  followUps,
  memories,
  existingContactPointsCount,
  companiesWithDiscoveryMetadataCount,
}) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  const norm = (rows, fields) =>
    rows
      .map((r) => Object.fromEntries(fields.map((f) => [f, iso(r[f])])))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const payload = {
    companies: norm(companies, ["id", "name", "website", "phone", "email", "sourceUrl", "industryId", "status", "createdAt"]),
    leads: norm(leads, ["id", "companyId", "source", "status", "createdByAgentTaskId", "createdAt"]),
    opportunities: norm(opportunities, ["id", "companyId", "title", "stage", "createdByAgentTaskId", "createdAt"]),
    activitiesCompany: norm(activitiesCompany, ["id", "entityId", "subject", "createdAt"]),
    activitiesLead: norm(activitiesLead, ["id", "entityId", "subject", "createdAt"]),
    activitiesOpportunity: norm(activitiesOpportunity, ["id", "entityId", "subject", "createdAt"]),
    followUps: norm(followUps, ["id", "entityType", "entityId", "createdAt"]),
    memories: norm(memories, ["id", "entityId", "content", "createdAt"]),
    existingContactPointsCount,
    companiesWithDiscoveryMetadataCount,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
