// Ejecución real v2 del backfill de consolidación de Illinois (75→29
// Companies), sobre el snapshot v2 aprobado (incorpora las 16
// Opportunities y las 75 AgentMemory reales que no existían en v1). Ver
// docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md §14 para el diseño completo y
// los conteos aprobados.
//
// SEGURO POR DEFECTO: sin --execute, este script SOLO lee (dry-run
// reforzado) — cero INSERT/UPDATE/DELETE. Con --execute, corre TODA la
// escritura dentro de una única transacción Prisma — cualquier error
// revierte el 100% de los cambios. Los 29 canonicalCompanyId del
// snapshot v2 se usan verbatim (nunca se recalcula la selección
// canónica). Las listas de reasignación (Opportunities/Activities/
// FollowUps/AgentMemory) se recalculan en fresco contra el estado real
// de la DB en cada corrida, protegidas por la revalidación exacta del
// snapshotHash extendido: si cualquiera de esas entidades cambió desde
// que se aprobó el snapshot v2, el hash no coincide y el script aborta
// sin escribir nada, antes de confiar en ninguna lista recalculada.
//
// Uso (dry-run reforzado, recomendado primero):
//   node --import tsx packages/db/scripts/execute-illinois-company-backfill-v2.mjs \
//     --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
//     --snapshot-hash=b7f8e08c2617fbdd255c139c44a11ba62c1aafccc4829da3abbed6a4f36e7217 \
//     --expected-companies=75 --expected-groups=29 --expected-company-deletes=46 \
//     --expected-leads=91 --expected-leads-final=45 --expected-lead-deletes=46 \
//     --expected-opportunities=16 --expected-opportunities-reassign=0 \
//     --expected-memories=75 --expected-memories-delete=46 --expected-memories-reassign=0 \
//     --expected-activities-reassign=92 --expected-followups-reassign=0 \
//     --expected-contact-points=22
//
// Uso (ejecución real, solo tras aprobación final explícita del PO
// sobre el resultado del dry-run reforzado de arriba): agregar --execute

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadCohort, loadRelationCounts, sumUnexpectedRelations } from "./illinois-backfill-lib.mjs";
import {
  classifyLeads,
  classifyOpportunities,
  classifyActivitiesByCompany,
  classifyActivitiesByLead,
  planAgentMemoryActions,
  computeExtendedSnapshotHash,
  buildGuardReportV2,
  loadLeadsForCompanies,
  loadOpportunitiesForCompanies,
  loadActivitiesForEntity,
  loadFollowUpsForEntity,
  loadCompanyMemories,
} from "./illinois-backfill-v2-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const args = { execute: false };
  for (const raw of argv) {
    if (raw === "--execute") {
      args.execute = true;
      continue;
    }
    const match = raw.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const REQUIRED_ARGS = [
  "tenant-id",
  "mission-task-id",
  "snapshot-hash",
  "expected-companies",
  "expected-groups",
  "expected-company-deletes",
  "expected-leads",
  "expected-leads-final",
  "expected-lead-deletes",
  "expected-opportunities",
  "expected-opportunities-reassign",
  "expected-memories",
  "expected-memories-delete",
  "expected-memories-reassign",
  "expected-activities-reassign",
  "expected-followups-reassign",
  "expected-contact-points",
];

export function validateArgs(args) {
  const missing = REQUIRED_ARGS.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `Argumentos requeridos faltantes: ${missing.map((m) => `--${m}`).join(", ")}` };
  }
  return { ok: true };
}

export function loadApprovedPlanV2(path = join(__dirname, "illinois-backfill-approved-groups-v2.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Carga todo el estado v2 relevante en fresco (Companies, Leads,
 * Opportunities, Activities, FollowUps, AgentMemory) usando el cliente
 * Prisma recibido (real o `tx` dentro de una transacción) — nunca
 * confía en listas calculadas en una corrida anterior. Devuelve todo lo
 * necesario para clasificar y para recomputar el snapshotHash.
 */
async function loadFreshState(prisma, discoverTaskIds) {
  const cohort = await loadCohort(prisma, discoverTaskIds);
  const cohortIds = cohort.map((c) => c.id);
  const leads = await loadLeadsForCompanies(prisma, cohortIds);
  const opportunities = await loadOpportunitiesForCompanies(prisma, cohortIds);
  const activitiesCompany = await loadActivitiesForEntity(prisma, "company", cohortIds);
  const activitiesLead = await loadActivitiesForEntity(prisma, "lead", leads.map((l) => l.id));
  const activitiesOpportunity = await loadActivitiesForEntity(prisma, "opportunity", opportunities.map((o) => o.id));
  const followUpsCompany = await loadFollowUpsForEntity(prisma, "company", cohortIds);
  const followUpsLead = await loadFollowUpsForEntity(prisma, "lead", leads.map((l) => l.id));
  const followUpsOpportunity = await loadFollowUpsForEntity(prisma, "opportunity", opportunities.map((o) => o.id));
  const memories = await loadCompanyMemories(prisma, cohortIds);
  const existingContactPointsCount = await prisma.companyContactPoint.count({ where: { companyId: { in: cohortIds } } });
  const companiesWithDiscoveryMetadataCount = await prisma.company.count({
    where: { id: { in: cohortIds }, NOT: { discoveryMetadata: { equals: null } } },
  });
  return {
    cohort,
    cohortIds,
    leads,
    opportunities,
    activitiesCompany,
    activitiesLead,
    activitiesOpportunity,
    followUpsCompany,
    followUpsLead,
    followUpsOpportunity,
    memories,
    existingContactPointsCount,
    companiesWithDiscoveryMetadataCount,
  };
}

/**
 * Clasifica el estado fresco cargado por loadFreshState() contra el
 * mapping canónico/duplicado del plan (nunca recalculado) — misma
 * lógica exacta usada por el dry-run v2, para que evaluación y
 * transacción vean siempre el mismo resultado ante el mismo estado.
 */
function classifyState(state, plan) {
  const canonicalIdSet = new Set(plan.groups.map((g) => g.canonicalCompanyId));
  const duplicateIdSet = new Set(plan.groups.flatMap((g) => g.duplicateCompanyIds));
  const canonicalByDuplicateId = new Map();
  for (const g of plan.groups) for (const dupId of g.duplicateCompanyIds) canonicalByDuplicateId.set(dupId, g.canonicalCompanyId);
  const leadsById = new Map(state.leads.map((l) => [l.id, l]));

  const leadClassification = classifyLeads(state.leads, canonicalIdSet, duplicateIdSet);
  const oppClassification = classifyOpportunities(state.opportunities, canonicalIdSet, duplicateIdSet);
  const opportunityReassignments = oppClassification.onDuplicate.map((o) => ({
    opportunityId: o.id,
    fromCompanyId: o.companyId,
    toCompanyId: canonicalByDuplicateId.get(o.companyId),
  }));

  const activitiesCompanyClassified = classifyActivitiesByCompany(state.activitiesCompany, duplicateIdSet);
  const companyActivityReassignments = activitiesCompanyClassified.onDuplicate.map((a) => ({
    activityId: a.id,
    toCompanyId: canonicalByDuplicateId.get(a.entityId),
  }));

  const activitiesLeadClassified = classifyActivitiesByLead(state.activitiesLead, leadsById, duplicateIdSet);
  const leadActivityReassignments = activitiesLeadClassified.onDuplicateLead.map((a) => {
    const lead = leadsById.get(a.entityId);
    const group = plan.groups.find((g) => g.canonicalCompanyId === canonicalByDuplicateId.get(lead.companyId));
    return { activityId: a.id, toLeadId: group?.survivingLeadId ?? null };
  });

  const followUpsLeadOnDuplicate = state.followUpsLead.filter((f) => {
    const lead = leadsById.get(f.entityId);
    return lead && duplicateIdSet.has(lead.companyId);
  });
  const followUpReassignments = followUpsLeadOnDuplicate.map((f) => {
    const lead = leadsById.get(f.entityId);
    const group = plan.groups.find((g) => g.canonicalCompanyId === canonicalByDuplicateId.get(lead.companyId));
    return { followUpId: f.id, toLeadId: group?.survivingLeadId ?? null };
  });
  const followUpsCompanyOnDuplicate = state.followUpsCompany.filter((f) => duplicateIdSet.has(f.entityId));
  const companyFollowUpReassignments = followUpsCompanyOnDuplicate.map((f) => ({
    followUpId: f.id,
    toCompanyId: canonicalByDuplicateId.get(f.entityId),
  }));

  const memoryActions = planAgentMemoryActions(state.memories, plan.groups);

  return {
    canonicalIdSet,
    duplicateIdSet,
    leadClassification,
    oppClassification,
    opportunityReassignments,
    companyActivityReassignments,
    leadActivityReassignments,
    followUpReassignments,
    companyFollowUpReassignments,
    memoryActions,
  };
}

/**
 * Evalúa el estado real contra el plan v2 aprobado y produce un reporte
 * completo — no escribe nada. Usado tanto por el dry-run reforzado
 * como por el primer paso (fuera de la transacción) de la ejecución
 * real.
 */
export async function evaluateCohortV2(prisma, plan, args) {
  const state = await loadFreshState(prisma, plan.discoverTaskIds);
  const cohortIdSet = new Set(state.cohortIds);

  const approvedCanonicalIds = plan.groups.map((g) => g.canonicalCompanyId);
  const approvedCanonicalIdSet = new Set(approvedCanonicalIds);

  // ---------- Idempotencia (estado real, nunca una bandera) ----------
  if (state.cohort.length === plan.groups.length) {
    const matchesCanonicalSet = cohortIdSet.size === approvedCanonicalIdSet.size && [...cohortIdSet].every((id) => approvedCanonicalIdSet.has(id));
    if (matchesCanonicalSet && state.existingContactPointsCount >= plan.counts.contactPointsProposed && state.companiesWithDiscoveryMetadataCount >= plan.groups.length) {
      return {
        alreadyApplied: true,
        message: "Backfill v2 already applied or source cohort changed",
        details: {
          canonicalCompaniesFound: state.cohort.length,
          existingContactPoints: state.existingContactPointsCount,
          companiesWithDiscoveryMetadata: state.companiesWithDiscoveryMetadataCount,
        },
      };
    }
  }

  const approvedCompanyIds = plan.companiesSnapshot.map((c) => c.id);
  const idsMatchApproved = cohortIdSet.size === approvedCompanyIds.length && approvedCompanyIds.every((id) => cohortIdSet.has(id));

  const planReferencedIds = plan.groups.flatMap((g) => [g.canonicalCompanyId, ...g.duplicateCompanyIds]);
  const missingPlanIds = planReferencedIds.filter((id) => !cohortIdSet.has(id));

  const classified = classifyState(state, plan);

  const survivingLeadFailures = [];
  const leadsById = new Map(state.leads.map((l) => [l.id, l]));
  for (const g of plan.groups) {
    if (!g.survivingLeadId) continue;
    const lead = leadsById.get(g.survivingLeadId);
    if (!lead) survivingLeadFailures.push({ check: "survivingLeadMissing", group: g.providerPlaceId });
    else if (lead.companyId !== g.canonicalCompanyId) survivingLeadFailures.push({ check: "survivingLeadCompanyMismatch", group: g.providerPlaceId });
  }

  const recomputedHash = computeExtendedSnapshotHash({
    companies: state.cohort,
    leads: state.leads,
    opportunities: state.opportunities,
    activitiesCompany: state.activitiesCompany,
    activitiesLead: state.activitiesLead,
    activitiesOpportunity: state.activitiesOpportunity,
    followUps: [...state.followUpsCompany, ...state.followUpsLead, ...state.followUpsOpportunity],
    memories: state.memories,
    existingContactPointsCount: state.existingContactPointsCount,
    companiesWithDiscoveryMetadataCount: state.companiesWithDiscoveryMetadataCount,
  });

  const memoriesToDelete = classified.memoryActions.filter((a) => a.action === "delete");
  const memoriesToReassign = classified.memoryActions.filter((a) => a.action === "reassign");
  const contactPointsCount = plan.groups.reduce((sum, g) => sum + g.contactPointProposals.length, 0);

  const actual = {
    tenantId: state.cohort.every((c) => c.tenantId === args["tenant-id"]) ? args["tenant-id"] : "MISMATCH",
    missionTaskId: plan.missionTaskId === args["mission-task-id"] ? args["mission-task-id"] : "MISMATCH",
    snapshotHash: recomputedHash,
    companiesCount: state.cohort.length,
    groupsCount: plan.groups.length,
    companyDeletesCount: classified.duplicateIdSet.size,
    leadsCount: state.leads.length,
    leadsFinalCount: state.leads.length - classified.leadClassification.missionLeadsOnDuplicate.length,
    leadDeletesCount: classified.leadClassification.missionLeadsOnDuplicate.length,
    opportunitiesCount: state.opportunities.length,
    opportunitiesReassignCount: classified.opportunityReassignments.length,
    memoriesCount: state.memories.length,
    memoriesDeleteCount: memoriesToDelete.length,
    memoriesReassignCount: memoriesToReassign.length,
    activitiesReassignCount: classified.companyActivityReassignments.length + classified.leadActivityReassignments.length,
    followUpsReassignCount: classified.followUpReassignments.length + classified.companyFollowUpReassignments.length,
    contactPointsCount,
    existingContactPointsForCohort: state.existingContactPointsCount,
    companiesWithNonNullDiscoveryMetadata: state.companiesWithDiscoveryMetadataCount,
  };
  const expected = {
    tenantId: args["tenant-id"],
    missionTaskId: args["mission-task-id"],
    snapshotHash: args["snapshot-hash"],
    companiesCount: Number(args["expected-companies"]),
    groupsCount: Number(args["expected-groups"]),
    companyDeletesCount: Number(args["expected-company-deletes"]),
    leadsCount: Number(args["expected-leads"]),
    leadsFinalCount: Number(args["expected-leads-final"]),
    leadDeletesCount: Number(args["expected-lead-deletes"]),
    opportunitiesCount: Number(args["expected-opportunities"]),
    opportunitiesReassignCount: Number(args["expected-opportunities-reassign"]),
    memoriesCount: Number(args["expected-memories"]),
    memoriesDeleteCount: Number(args["expected-memories-delete"]),
    memoriesReassignCount: Number(args["expected-memories-reassign"]),
    activitiesReassignCount: Number(args["expected-activities-reassign"]),
    followUpsReassignCount: Number(args["expected-followups-reassign"]),
    contactPointsCount: Number(args["expected-contact-points"]),
  };

  const guardReport = buildGuardReportV2(actual, expected);
  if (!idsMatchApproved) guardReport.failures.push({ check: "companyIdSet", expected: "matches plan v2", actual: "diverges from plan v2" });
  if (missingPlanIds.length > 0) guardReport.failures.push({ check: "planReferencedCompanyIds", expected: "all present in cohort", actual: `missing: ${missingPlanIds.join(", ")}` });
  if (classified.oppClassification.onUnknown.length > 0) guardReport.failures.push({ check: "opportunityUnknownCompany", expected: 0, actual: classified.oppClassification.onUnknown.length });
  if (classified.oppClassification.multiplePerCompany.length > 0) guardReport.failures.push({ check: "multipleOpportunitiesPerCompany", expected: 0, actual: classified.oppClassification.multiplePerCompany.length });
  if (classified.leadClassification.pipelineLeadsOnDuplicate.length > 0) guardReport.failures.push({ check: "pipelineLeadsOnDuplicate", expected: 0, actual: classified.leadClassification.pipelineLeadsOnDuplicate.length });
  if (classified.leadClassification.otherLeads.length > 0) guardReport.failures.push({ check: "unknownLeadSource", expected: 0, actual: classified.leadClassification.otherLeads.length });
  for (const f of survivingLeadFailures) guardReport.failures.push(f);

  const ok = guardReport.failures.length === 0;

  return { alreadyApplied: false, ok, failures: guardReport.failures, actual, expected, state, classified, plan };
}

/**
 * Toda la escritura real, dentro de una única transacción Prisma —
 * exportada por separado para que los tests puedan ejercitarla contra
 * un fixture desechable. Cualquier excepción revierte el 100% de los
 * cambios (ROLLBACK automático de Prisma). Orden: 1) revalidar
 * snapshot; 2) discoveryMetadata; 3) CompanyContactPoint; 4) reasignar
 * Opportunities; 5) reasignar FollowUps; 6) reasignar Activities; 7)
 * consolidar Leads (reasignar survivor); 8) acciones de AgentMemory
 * (delete/reassign); 9) validar cero relaciones bloqueantes restantes;
 * 10) eliminar Leads duplicados; 11) eliminar Companies duplicadas; 12)
 * post-validación; 13) devolver (commit lo hace Prisma al resolver).
 */
export async function runBackfillTransactionV2(prisma, plan, args) {
  return prisma.$transaction(async (tx) => {
    // 1. Revalidar snapshot dentro de la transacción.
    const freshState = await loadFreshState(tx, plan.discoverTaskIds);
    const freshHash = computeExtendedSnapshotHash({
      companies: freshState.cohort,
      leads: freshState.leads,
      opportunities: freshState.opportunities,
      activitiesCompany: freshState.activitiesCompany,
      activitiesLead: freshState.activitiesLead,
      activitiesOpportunity: freshState.activitiesOpportunity,
      followUps: [...freshState.followUpsCompany, ...freshState.followUpsLead, ...freshState.followUpsOpportunity],
      memories: freshState.memories,
      existingContactPointsCount: freshState.existingContactPointsCount,
      companiesWithDiscoveryMetadataCount: freshState.companiesWithDiscoveryMetadataCount,
    });
    if (freshHash !== plan.snapshotHash) {
      throw new Error(`Snapshot v2 cambió justo antes de escribir (hash esperado ${plan.snapshotHash}, actual ${freshHash}) — abortando.`);
    }

    const classified = classifyState(freshState, plan);
    const now = new Date();
    let discoveryMetadataWritten = 0;
    let contactPointsCreated = 0;
    let opportunitiesReassigned = 0;
    let followUpsReassigned = 0;
    let activitiesReassigned = 0;
    let leadsReassigned = 0;
    let memoriesDeleted = 0;
    let memoriesReassigned = 0;
    let leadsDeleted = 0;
    let companiesDeleted = 0;

    for (const group of plan.groups) {
      // 2. discoveryMetadata en la canónica (ya incluye los campos
      // extendidos de v2 — prospectingSchedulerProcessed/
      // prospectingLeadIds/opportunityIds/stabilizationMemoryIds —
      // calculados en el dry-run v2 y congelados en el plan).
      await tx.company.update({
        where: { id: group.canonicalCompanyId },
        data: {
          discoveryMetadata: {
            ...group.proposedDiscoveryMetadata,
            missionTaskId: plan.missionTaskId,
            backfillSnapshotHash: plan.snapshotHash,
            lastUpdatedAt: now.toISOString(),
          },
        },
      });
      discoveryMetadataWritten++;

      // 3. CompanyContactPoint (upsert — defensa de idempotencia extra
      // dentro de la propia transacción).
      for (const proposal of group.contactPointProposals) {
        await tx.companyContactPoint.upsert({
          where: { companyId_email: { companyId: group.canonicalCompanyId, email: proposal.email } },
          create: {
            tenantId: args["tenant-id"],
            companyId: group.canonicalCompanyId,
            email: proposal.email,
            type: proposal.type,
            sourceUrl: proposal.sourceUrl,
            discoveryProvider: proposal.discoveryProvider,
            verificationStatus: proposal.verificationStatus,
          },
          update: {},
        });
        contactPointsCreated++;
      }
    }

    // 4. Reasignar Opportunities de duplicada → canónica (0 esperadas
    // en la cohorte real, pero el mecanismo se ejecuta genéricamente).
    for (const r of classified.opportunityReassignments) {
      await tx.opportunity.update({ where: { id: r.opportunityId }, data: { companyId: r.toCompanyId } });
      opportunitiesReassigned++;
    }

    // 5. Reasignar FollowUps (company y lead) de duplicada → canónica/
    // survivor (0 esperados en la cohorte real).
    for (const r of classified.companyFollowUpReassignments) {
      await tx.followUp.update({ where: { id: r.followUpId }, data: { entityId: r.toCompanyId } });
      followUpsReassigned++;
    }
    for (const r of classified.followUpReassignments) {
      if (!r.toLeadId) throw new Error(`FollowUp ${r.followUpId} no tiene un survivingLeadId de destino — abortando.`);
      await tx.followUp.update({ where: { id: r.followUpId }, data: { entityId: r.toLeadId } });
      followUpsReassigned++;
    }

    // 6. Reasignar Activities (company y lead) de duplicada → canónica/survivor.
    for (const r of classified.companyActivityReassignments) {
      await tx.activity.update({ where: { id: r.activityId }, data: { entityId: r.toCompanyId } });
      activitiesReassigned++;
    }
    for (const r of classified.leadActivityReassignments) {
      if (!r.toLeadId) throw new Error(`Activity ${r.activityId} no tiene un survivingLeadId de destino — abortando.`);
      await tx.activity.update({ where: { id: r.activityId }, data: { entityId: r.toLeadId } });
      activitiesReassigned++;
    }

    // 7. Consolidar Leads: reasignar el Lead sobreviviente si no apunta
    // ya a la canónica.
    for (const group of plan.groups) {
      if (!group.survivingLeadId) continue;
      const survivingLead = freshState.leads.find((l) => l.id === group.survivingLeadId);
      if (survivingLead && survivingLead.companyId !== group.canonicalCompanyId) {
        await tx.lead.update({ where: { id: group.survivingLeadId }, data: { companyId: group.canonicalCompanyId } });
        leadsReassigned++;
      }
    }

    // 8. Acciones de AgentMemory — eliminar las que ya están cubiertas
    // por su canónica, reasignar (UPDATE entityId) las que dejarían a
    // su canónica sin cobertura. Nunca se crea una segunda memoria en
    // una canónica ya cubierta.
    for (const action of classified.memoryActions) {
      if (action.action === "delete") {
        await tx.agentMemory.delete({ where: { id: action.memoryId } });
        memoriesDeleted++;
      } else if (action.action === "reassign") {
        await tx.agentMemory.update({ where: { id: action.memoryId }, data: { entityId: action.canonicalId } });
        memoriesReassigned++;
      } else if (action.action === "unknown_company") {
        throw new Error(`AgentMemory ${action.memoryId} está en una Company fuera del plan v2 — abortando.`);
      }
    }

    // 9. Validar que las duplicadas no tengan relaciones bloqueantes
    // pendientes (Contact/Opportunity/CampaignCompany/JobOrder/Project/
    // Invoice/Contract) antes de borrar nada.
    const duplicateIds = [...classified.duplicateIdSet];
    if (duplicateIds.length > 0) {
      const relCounts = await loadRelationCounts(tx, duplicateIds);
      const blocking = sumUnexpectedRelations(relCounts);
      if (blocking > 0) {
        throw new Error(`Las Companies duplicadas todavía tienen ${blocking} relación(es) bloqueante(s) sin reasignar — abortando. Detalle: ${JSON.stringify(relCounts)}`);
      }
    }

    // 10. Eliminar los Leads duplicados (misión, ya sin Activities/
    // FollowUps propios — reasignados en los pasos 5-6).
    const leadIdsToRemove = classified.leadClassification.missionLeadsOnDuplicate.map((l) => l.id);
    if (leadIdsToRemove.length > 0) {
      const del = await tx.lead.deleteMany({ where: { id: { in: leadIdsToRemove } } });
      leadsDeleted = del.count;
    }

    // 11. Eliminar las Companies duplicadas.
    if (duplicateIds.length > 0) {
      const del = await tx.company.deleteMany({ where: { id: { in: duplicateIds } } });
      companiesDeleted = del.count;
    }

    // 12. Post-validación dentro de la misma transacción.
    const finalCompanies = await tx.company.count({ where: { discoveredByAgentTaskId: { in: plan.discoverTaskIds } } });
    if (finalCompanies !== plan.groups.length) {
      throw new Error(`Post-validación falló: se esperaban ${plan.groups.length} Companies finales, hay ${finalCompanies}.`);
    }
    const finalCompanyIds = (await tx.company.findMany({ where: { discoveredByAgentTaskId: { in: plan.discoverTaskIds } }, select: { id: true } })).map((c) => c.id);
    const finalLeads = await tx.lead.count({ where: { companyId: { in: finalCompanyIds } } });
    const finalOpportunities = await tx.opportunity.count({ where: { companyId: { in: finalCompanyIds } } });
    const finalMemories = await tx.agentMemory.count({ where: { entityType: "company", entityId: { in: finalCompanyIds } } });
    if (finalOpportunities !== freshState.opportunities.length) {
      throw new Error(`Post-validación falló: las Opportunities deben preservarse íntegras (esperadas ${freshState.opportunities.length}, hay ${finalOpportunities}).`);
    }
    if (finalMemories !== plan.groups.length) {
      throw new Error(`Post-validación falló: se esperaba 1 AgentMemory por canónica (${plan.groups.length}), hay ${finalMemories}.`);
    }
    const danglingLeads = await tx.lead.count({ where: { companyId: { in: duplicateIds } } });
    const danglingMemories = await tx.agentMemory.count({ where: { entityType: "company", entityId: { in: duplicateIds } } });
    if (danglingLeads > 0 || danglingMemories > 0) {
      throw new Error(`Post-validación falló: ${danglingLeads} Lead(s) y ${danglingMemories} AgentMemory todavía apuntan a una Company duplicada eliminada.`);
    }

    return {
      discoveryMetadataWritten,
      contactPointsCreated,
      opportunitiesReassigned,
      followUpsReassigned,
      activitiesReassigned,
      leadsReassigned,
      memoriesDeleted,
      memoriesReassigned,
      leadsDeleted,
      companiesDeleted,
      finalCompanies,
      finalLeads,
      finalOpportunities,
      finalMemories,
    };
  });
}

function printSummary(label, obj) {
  console.log(`\n${label}`);
  for (const [k, v] of Object.entries(obj)) console.log(`  ${k}: ${v}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const argCheck = validateArgs(args);
  if (!argCheck.ok) {
    console.error(argCheck.reason);
    process.exit(1);
  }

  const plan = loadApprovedPlanV2();
  if (plan.snapshotHash !== args["snapshot-hash"]) {
    console.error(`--snapshot-hash no coincide con el plan v2 aprobado (esperado por el plan: ${plan.snapshotHash}, recibido: ${args["snapshot-hash"]}).`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  let exitCode = 0;
  try {
    const evaluation = await evaluateCohortV2(prisma, plan, args);

    if (evaluation.alreadyApplied) {
      console.log(evaluation.message);
      printSummary("Detalle:", evaluation.details);
      process.exit(0);
    }

    if (!evaluation.ok) {
      console.error("BLOCKERS — la ejecución no debe proceder:");
      console.error(JSON.stringify(evaluation.failures, null, 2));
      process.exit(1);
    }

    printSummary("Antes:", {
      Companies: evaluation.actual.companiesCount,
      Leads: evaluation.actual.leadsCount,
      Opportunities: evaluation.actual.opportunitiesCount,
      AgentMemory: evaluation.actual.memoriesCount,
      CompanyContactPoint: evaluation.actual.existingContactPointsForCohort,
    });
    printSummary("Después esperado:", {
      "Companies canónicas": evaluation.expected.groupsCount,
      "Companies eliminadas": evaluation.expected.companyDeletesCount,
      "Leads finales": evaluation.expected.leadsFinalCount,
      "Leads eliminados": evaluation.expected.leadDeletesCount,
      "Opportunities reasignadas": evaluation.expected.opportunitiesReassignCount,
      "Opportunities preservadas sin cambio": evaluation.actual.opportunitiesCount - evaluation.actual.opportunitiesReassignCount,
      "AgentMemory eliminadas": evaluation.expected.memoriesDeleteCount,
      "AgentMemory reasignadas": evaluation.expected.memoriesReassignCount,
      "Activities reasignadas": evaluation.expected.activitiesReassignCount,
      "FollowUps reasignados": evaluation.expected.followUpsReassignCount,
      "CompanyContactPoint creados": evaluation.expected.contactPointsCount,
      "discoveryMetadata escrito": evaluation.expected.groupsCount,
    });

    if (!args.execute) {
      console.log("\nDRY-RUN REFORZADO — sin --execute, cero escrituras. Todas las guardas pasaron.");
      process.exit(0);
    }

    console.log("\n--execute recibido — abriendo transacción de escritura...");
    const result = await runBackfillTransactionV2(prisma, plan, args);

    printSummary("Resultado real:", result);
    console.log("\nCOMMIT exitoso.");
  } catch (err) {
    console.error("\nERROR — ROLLBACK aplicado (o nunca se abrió transacción de escritura):");
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
