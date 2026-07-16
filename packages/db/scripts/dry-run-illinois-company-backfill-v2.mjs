// Dry-run v2 del backfill de consolidación de Illinois (75→29
// Companies) — revisión que incorpora las 16 Opportunities y las 75
// AgentMemory reales que no existían cuando se congeló el snapshot v1
// (illinois-backfill-approved-groups.json), producidas por: (a) el
// prospecting-pipeline real, que corrió sobre 16 de las 75 Companies
// entre el snapshot v1 y el intento de --execute que abortó por drift;
// (b) la estabilización de Opción C, que creó 59 AgentMemory para
// dejar el resto de la cohorte fuera del scheduler. Ver
// docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md §14 para el contexto completo.
//
// SOLO LECTURA — cero INSERT/UPDATE/DELETE. Mantiene exactamente los 29
// canonicalCompanyId ya aprobados (nunca recalcula la selección
// canónica) salvo que el estado real haga imposible conservar alguno,
// en cuyo caso ABORTA y reporta el conflicto en vez de decidir
// unilateralmente. Produce un nuevo snapshot hash y un nuevo archivo
// congelado illinois-backfill-approved-groups-v2.json — no ejecuta
// ninguna consolidación real.
//
// Uso:
//   node --import tsx packages/db/scripts/dry-run-illinois-company-backfill-v2.mjs \
//     --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadCohort } from "./illinois-backfill-lib.mjs";
import {
  classifyLeads,
  classifyOpportunities,
  classifyActivitiesByCompany,
  classifyActivitiesByLead,
  planAgentMemoryActions,
  classifyMemory,
  computeExtendedSnapshotHash,
  loadLeadsForCompanies,
  loadOpportunitiesForCompanies,
  loadActivitiesForEntity,
  loadFollowUpsForEntity,
  loadCompanyMemories,
} from "./illinois-backfill-v2-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = raw.match(/^--([a-z-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const REQUIRED_ARGS = ["tenant-id", "mission-task-id"];

export function validateArgs(args) {
  const missing = REQUIRED_ARGS.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `Argumentos requeridos faltantes: ${missing.map((m) => `--${m}`).join(", ")}` };
  }
  return { ok: true };
}

export function loadV1Plan(path = join(__dirname, "illinois-backfill-approved-groups.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Toda la lectura + clasificación — sin efectos secundarios más allá de
 * consultas SELECT. Devuelve un reporte completo o `{ ok: false,
 * blockers }` si algo hace imposible conservar el plan v1 tal cual.
 * Exportada por separado para que los tests puedan ejercitarla contra
 * un fixture desechable.
 */
export async function buildV2Report(prisma, v1Plan, args) {
  const tenantId = args["tenant-id"];
  const missionTaskId = args["mission-task-id"];
  const blockers = [];

  const cohort = await loadCohort(prisma, v1Plan.discoverTaskIds);
  const cohortIds = cohort.map((c) => c.id);
  const cohortIdSet = new Set(cohortIds);

  const approvedIds = v1Plan.companiesSnapshot.map((c) => c.id);
  const idsMatchV1 = cohortIdSet.size === approvedIds.length && approvedIds.every((id) => cohortIdSet.has(id));
  if (!idsMatchV1) {
    blockers.push({
      check: "companyIdSet",
      detail: "La cohorte actual ya no coincide con las 75 Companies del plan v1 — no se puede conservar el plan sin revisión manual.",
    });
  }
  if (!cohort.every((c) => c.tenantId === tenantId)) {
    blockers.push({ check: "tenantId", detail: "Alguna Company de la cohorte no pertenece al tenant esperado." });
  }

  const canonicalIdSet = new Set(v1Plan.groups.map((g) => g.canonicalCompanyId));
  const duplicateIdSet = new Set(v1Plan.groups.flatMap((g) => g.duplicateCompanyIds));
  const canonicalByDuplicateId = new Map();
  for (const g of v1Plan.groups) for (const dupId of g.duplicateCompanyIds) canonicalByDuplicateId.set(dupId, g.canonicalCompanyId);

  // Cada canónica/duplicada que el plan v1 declara debe seguir
  // existiendo realmente en la cohorte — igual que en evaluateCohort()
  // del script de ejecución v1 (protección contra un plan corrompido).
  const planReferencedIds = v1Plan.groups.flatMap((g) => [g.canonicalCompanyId, ...g.duplicateCompanyIds]);
  const missingPlanIds = planReferencedIds.filter((id) => !cohortIdSet.has(id));
  if (missingPlanIds.length > 0) {
    blockers.push({ check: "planReferencedCompanyIds", detail: `Ids del plan v1 ausentes en la cohorte: ${missingPlanIds.join(", ")}` });
  }

  const leads = await loadLeadsForCompanies(prisma, cohortIds);
  const leadsById = new Map(leads.map((l) => [l.id, l]));
  const leadClassification = classifyLeads(leads, canonicalIdSet, duplicateIdSet);

  if (leadClassification.pipelineLeadsOnDuplicate.length > 0) {
    blockers.push({
      check: "pipelineLeadsOnDuplicate",
      detail: `${leadClassification.pipelineLeadsOnDuplicate.length} Lead(s) de prospecting-pipeline están en una Company duplicada — requiere diseño de reasignación adicional antes de continuar.`,
      leadIds: leadClassification.pipelineLeadsOnDuplicate.map((l) => l.id),
    });
  }
  if (leadClassification.otherLeads.length > 0) {
    blockers.push({
      check: "unknownLeadSource",
      detail: `${leadClassification.otherLeads.length} Lead(s) con un source no reconocido (ni external-discovery-mission ni prospecting-pipeline).`,
      leadIds: leadClassification.otherLeads.map((l) => l.id),
    });
  }

  // Revalidar que cada survivingLeadId del plan v1 sigue existiendo y
  // sigue apuntando a su Company canónica — nunca se recalcula el
  // canonical, solo se confirma que sigue siendo válido.
  for (const g of v1Plan.groups) {
    if (!g.survivingLeadId) continue;
    const lead = leadsById.get(g.survivingLeadId);
    if (!lead) {
      blockers.push({ check: "survivingLeadMissing", detail: `survivingLeadId ${g.survivingLeadId} del grupo ${g.providerPlaceId} ya no existe.` });
    } else if (lead.companyId !== g.canonicalCompanyId) {
      blockers.push({
        check: "survivingLeadCompanyMismatch",
        detail: `survivingLeadId ${g.survivingLeadId} ya no apunta a la Company canónica ${g.canonicalCompanyId} (apunta a ${lead.companyId}).`,
      });
    }
  }

  const opportunities = await loadOpportunitiesForCompanies(prisma, cohortIds);
  const oppClassification = classifyOpportunities(opportunities, canonicalIdSet, duplicateIdSet);
  if (oppClassification.onUnknown.length > 0) {
    blockers.push({ check: "opportunityUnknownCompany", detail: `${oppClassification.onUnknown.length} Opportunity(ies) en una Company fuera del plan v1.` });
  }
  if (oppClassification.multiplePerCompany.length > 0) {
    blockers.push({
      check: "multipleOpportunitiesPerCompany",
      detail: "Más de una Opportunity en la misma Company — requiere una regla explícita del PO antes de continuar (no se fusionan automáticamente).",
      groups: oppClassification.multiplePerCompany,
    });
  }
  const opportunityReassignments = oppClassification.onDuplicate.map((o) => ({
    opportunityId: o.id,
    fromCompanyId: o.companyId,
    toCompanyId: canonicalByDuplicateId.get(o.companyId),
  }));

  const activitiesCompany = await loadActivitiesForEntity(prisma, "company", cohortIds);
  const activitiesLeadRows = await loadActivitiesForEntity(prisma, "lead", leads.map((l) => l.id));
  const activitiesOpportunity = await loadActivitiesForEntity(prisma, "opportunity", opportunities.map((o) => o.id));

  const activitiesCompanyClassified = classifyActivitiesByCompany(activitiesCompany, duplicateIdSet);
  const activitiesLeadClassified = classifyActivitiesByLead(activitiesLeadRows, leadsById, duplicateIdSet);

  const companyActivityReassignments = activitiesCompanyClassified.onDuplicate.map((a) => ({
    activityId: a.id,
    fromCompanyId: a.entityId,
    toCompanyId: canonicalByDuplicateId.get(a.entityId),
  }));
  const leadActivityReassignments = activitiesLeadClassified.onDuplicateLead.map((a) => {
    const lead = leadsById.get(a.entityId);
    const group = v1Plan.groups.find((g) => g.canonicalCompanyId === canonicalByDuplicateId.get(lead.companyId));
    return { activityId: a.id, fromLeadId: a.entityId, toLeadId: group?.survivingLeadId ?? null };
  });
  if (leadActivityReassignments.some((r) => r.toLeadId === null)) {
    blockers.push({ check: "leadActivityReassignmentMissingTarget", detail: "Alguna Activity de Lead duplicado no tiene un survivingLeadId de destino." });
  }

  const followUpsCompany = await loadFollowUpsForEntity(prisma, "company", cohortIds);
  const followUpsLead = await loadFollowUpsForEntity(prisma, "lead", leads.map((l) => l.id));
  const followUpsOpportunity = await loadFollowUpsForEntity(prisma, "opportunity", opportunities.map((o) => o.id));
  const followUpsLeadOnDuplicate = followUpsLead.filter((f) => {
    const lead = leadsById.get(f.entityId);
    return lead && duplicateIdSet.has(lead.companyId);
  });
  const followUpsCompanyOnDuplicate = followUpsCompany.filter((f) => duplicateIdSet.has(f.entityId));

  const memories = await loadCompanyMemories(prisma, cohortIds);
  const memoryActions = planAgentMemoryActions(memories, v1Plan.groups);
  const memoriesToDelete = memoryActions.filter((a) => a.action === "delete");
  const memoriesToReassign = memoryActions.filter((a) => a.action === "reassign");
  const memoriesToKeep = memoryActions.filter((a) => a.action === "keep");
  const memoriesUnknown = memoryActions.filter((a) => a.action === "unknown_company");
  if (memoriesUnknown.length > 0) {
    blockers.push({ check: "agentMemoryUnknownCompany", detail: `${memoriesUnknown.length} AgentMemory en una Company fuera del plan v1.` });
  }

  const existingContactPointsCount = await prisma.companyContactPoint.count({ where: { companyId: { in: cohortIds } } });
  const companiesWithDiscoveryMetadataCount = await prisma.company.count({
    where: { id: { in: cohortIds }, NOT: { discoveryMetadata: { equals: null } } },
  });

  const snapshotHash = computeExtendedSnapshotHash({
    companies: cohort,
    leads,
    opportunities,
    activitiesCompany,
    activitiesLead: activitiesLeadRows,
    activitiesOpportunity,
    followUps: [...followUpsCompany, ...followUpsLead, ...followUpsOpportunity],
    memories,
    existingContactPointsCount,
    companiesWithDiscoveryMetadataCount,
  });

  // Segunda pasada de conteos — defensa contra que algo haya cambiado
  // mientras se calculaba el reporte de arriba. Si cualquiera difiere,
  // esto se trata como blocker (abortar, no escribir el snapshot v2).
  const recheckCohort = await loadCohort(prisma, v1Plan.discoverTaskIds);
  const recheckLeads = await loadLeadsForCompanies(prisma, cohortIds);
  const recheckOpportunities = await loadOpportunitiesForCompanies(prisma, cohortIds);
  const recheckMemories = await loadCompanyMemories(prisma, cohortIds);
  if (recheckCohort.length !== cohort.length) blockers.push({ check: "raceCompaniesCount", detail: `Companies cambió de ${cohort.length} a ${recheckCohort.length} durante el cálculo.` });
  if (recheckLeads.length !== leads.length) blockers.push({ check: "raceLeadsCount", detail: `Leads cambió de ${leads.length} a ${recheckLeads.length} durante el cálculo.` });
  if (recheckOpportunities.length !== opportunities.length) blockers.push({ check: "raceOpportunitiesCount", detail: `Opportunities cambió de ${opportunities.length} a ${recheckOpportunities.length} durante el cálculo.` });
  if (recheckMemories.length !== memories.length) blockers.push({ check: "raceMemoriesCount", detail: `AgentMemory cambió de ${memories.length} a ${recheckMemories.length} durante el cálculo.` });

  const finalLeadsCount = leads.length - leadClassification.missionLeadsOnDuplicate.length;
  const finalMemoriesCount = memories.length - memoriesToDelete.length;
  const finalActivitiesReassigned = companyActivityReassignments.length + leadActivityReassignments.length;

  const groupsV2 = v1Plan.groups.map((g) => {
    const canonicalPipelineLeads = leadClassification.pipelineLeadsOnCanonical.filter((l) => l.companyId === g.canonicalCompanyId);
    const canonicalOpportunities = oppClassification.onCanonical.filter((o) => o.companyId === g.canonicalCompanyId);
    const canonicalMemoryAction = memoryActions.find((a) => a.entityId === g.canonicalCompanyId && a.action === "keep");
    return {
      ...g,
      pipelineLeadIds: canonicalPipelineLeads.map((l) => l.id),
      opportunityIds: canonicalOpportunities.map((o) => o.id),
      opportunityReassignmentsIntoThisGroup: opportunityReassignments.filter((r) => r.toCompanyId === g.canonicalCompanyId),
      agentMemoryToDelete: memoriesToDelete.filter((a) => a.canonicalId === g.canonicalCompanyId).map((a) => a.memoryId),
      agentMemoryToReassign: memoriesToReassign.filter((a) => a.canonicalId === g.canonicalCompanyId).map((a) => a.memoryId),
      agentMemoryKeptId: canonicalMemoryAction?.memoryId ?? null,
      agentMemoryKeptKind: canonicalMemoryAction?.kind ?? null,
      proposedDiscoveryMetadata: {
        ...g.proposedDiscoveryMetadata,
        prospectingSchedulerProcessed: canonicalPipelineLeads.length > 0,
        prospectingLeadIds: canonicalPipelineLeads.map((l) => l.id),
        opportunityIds: canonicalOpportunities.map((o) => o.id),
        stabilizationMemoryIds: canonicalMemoryAction?.kind === "stabilization" && canonicalMemoryAction.memoryId ? [canonicalMemoryAction.memoryId] : [],
      },
    };
  });

  return {
    ok: blockers.length === 0,
    blockers,
    tenantId,
    missionTaskId,
    snapshotHash,
    previousSnapshotHash: v1Plan.snapshotHash,
    discoverTaskIds: v1Plan.discoverTaskIds,
    counts: {
      companiesCurrent: cohort.length,
      groupsCurrent: v1Plan.groups.length,
      companyDeletesExpected: duplicateIdSet.size,
      leadsCurrent: leads.length,
      leadsFinalExpected: finalLeadsCount,
      leadsToRemove: leadClassification.missionLeadsOnDuplicate.length,
      pipelineLeadsUnchanged: leadClassification.pipelineLeadsOnCanonical.length,
      opportunitiesCurrent: opportunities.length,
      opportunitiesToReassign: opportunityReassignments.length,
      opportunitiesUnchanged: oppClassification.onCanonical.length - opportunityReassignments.length,
      opportunitiesToDelete: 0,
      memoriesCurrent: memories.length,
      memoriesFinalExpected: finalMemoriesCount,
      memoriesToDelete: memoriesToDelete.length,
      memoriesToReassign: memoriesToReassign.length,
      memoriesToKeep: memoriesToKeep.length,
      activitiesCompanyCurrent: activitiesCompany.length,
      activitiesLeadCurrent: activitiesLeadRows.length,
      activitiesOpportunityCurrent: activitiesOpportunity.length,
      activitiesToReassign: finalActivitiesReassigned,
      followUpsLeadOnDuplicate: followUpsLeadOnDuplicate.length,
      followUpsCompanyOnDuplicate: followUpsCompanyOnDuplicate.length,
      contactPointsExisting: existingContactPointsCount,
      contactPointsProposed: v1Plan.groups.reduce((sum, g) => sum + g.contactPointProposals.length, 0),
      companiesWithDiscoveryMetadata: companiesWithDiscoveryMetadataCount,
    },
    canonicalMappings: v1Plan.groups.map((g) => ({ canonicalCompanyId: g.canonicalCompanyId, duplicateCompanyIds: g.duplicateCompanyIds })),
    opportunityReassignments,
    companyActivityReassignments,
    leadActivityReassignments,
    memoryActions,
    groupsV2,
    companiesSnapshot: cohort,
  };
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

  const v1Plan = loadV1Plan();
  const prisma = new PrismaClient();
  let exitCode = 0;
  try {
    const report = await buildV2Report(prisma, v1Plan, args);

    printSummary("Conteos:", report.counts);

    if (!report.ok) {
      console.error("\nBLOCKERS — no se genera el snapshot v2:");
      console.error(JSON.stringify(report.blockers, null, 2));
      exitCode = 1;
    } else {
      console.log("\nTodas las guardas pasaron. Escribiendo snapshot v2 (solo el archivo del plan — cero escrituras en la base de datos)...");
      const outPath = join(__dirname, "illinois-backfill-approved-groups-v2.json");
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            tenantId: report.tenantId,
            missionTaskId: report.missionTaskId,
            discoverTaskIds: report.discoverTaskIds,
            snapshotHash: report.snapshotHash,
            previousSnapshotHash: report.previousSnapshotHash,
            groups: report.groupsV2,
            companiesSnapshot: report.companiesSnapshot,
            counts: report.counts,
          },
          null,
          2,
        ),
      );
      console.log(`Escrito: ${outPath}`);
      console.log(`snapshotHash v2: ${report.snapshotHash}`);
    }

    console.log("\nDRY-RUN — cero escrituras en la base de datos (Company/Lead/Opportunity/Activity/AgentMemory/CompanyContactPoint/discoveryMetadata sin modificar).");
  } catch (err) {
    console.error("\nERROR durante el dry-run v2:");
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
