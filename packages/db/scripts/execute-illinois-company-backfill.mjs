// Consolidación real de las 75 Company duplicadas de la misión de
// Illinois → 29 canónicas. Ver docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md
// para el diseño completo y la evidencia del dry-run.
//
// SEGURO POR DEFECTO: sin --execute, este script SOLO lee (dry-run
// reforzado) — cero INSERT/UPDATE/DELETE, cero transacción de escritura.
// Con --execute, corre TODA la escritura dentro de una única transacción
// Prisma — cualquier error revierte el 100% de los cambios.
//
// Uso (dry-run reforzado, recomendado primero):
//   node --import tsx packages/db/scripts/execute-illinois-company-backfill.mjs \
//     --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
//     --snapshot-hash=<hash> --expected-companies=75 --expected-groups=29 \
//     --expected-company-deletes=46 --expected-leads=75 --expected-lead-deletes=46 \
//     --expected-contact-points=22
//
// Uso (ejecución real, solo tras aprobación explícita del PO sobre el
// resultado del dry-run reforzado de arriba): agregar --execute

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  computeSnapshotHash,
  diffCompanySnapshots,
  buildGuardReport,
  loadCohort,
  loadRelationCounts,
  sumUnexpectedRelations,
} from "./illinois-backfill-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
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
  "expected-lead-deletes",
  "expected-contact-points",
];

export function loadApprovedPlan(path = join(__dirname, "illinois-backfill-approved-groups.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateArgs(args) {
  const missing = REQUIRED_ARGS.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `Argumentos requeridos faltantes: ${missing.map((m) => `--${m}`).join(", ")}` };
  }
  return { ok: true };
}

/**
 * Evalúa el estado real de la cohorte contra el plan aprobado y produce
 * un reporte completo. No escribe nada — usado tanto por el dry-run
 * reforzado como como primer paso de la ejecución real (antes de abrir
 * la transacción).
 */
export async function evaluateCohort(prisma, plan, args) {
  const discoverTaskIds = plan.discoverTaskIds;
  const cohort = await loadCohort(prisma, discoverTaskIds);
  const cohortIds = new Set(cohort.map((c) => c.id));

  const approvedCanonicalIds = plan.groups.map((g) => g.canonicalCompanyId);
  const approvedCanonicalIdSet = new Set(approvedCanonicalIds);

  // ---------- Chequeo de idempotencia (estado real, nunca una bandera) ----------
  if (cohort.length === plan.groups.length) {
    const matchesCanonicalSet =
      cohortIds.size === approvedCanonicalIdSet.size && [...cohortIds].every((id) => approvedCanonicalIdSet.has(id));
    if (matchesCanonicalSet) {
      const companyIds = [...cohortIds];
      const existingContactPoints = await prisma.companyContactPoint.count({ where: { companyId: { in: companyIds } } });
      const expectedContactPoints = plan.groups.reduce((sum, g) => sum + g.contactPointProposals.length, 0);
      if (existingContactPoints >= expectedContactPoints) {
        return {
          alreadyApplied: true,
          message: "Backfill already applied or source cohort changed",
          details: { canonicalCompaniesFound: cohort.length, existingContactPoints, expectedContactPoints },
        };
      }
    }
  }

  // ---------- Evaluación completa contra el plan aprobado (pinned) ----------
  const approvedCompanyIds = plan.companiesSnapshot.map((c) => c.id);
  const idsMatchApprovedSet =
    cohortIds.size === approvedCompanyIds.length && approvedCompanyIds.every((id) => cohortIds.has(id));

  // Cada canonicalCompanyId/duplicateCompanyId que el plan aprobado
  // declara debe existir realmente en la cohorte recién cargada — sin
  // este chequeo explícito, un plan corrompido (ej. un canonical
  // inexistente) podría pasar todas las demás guardas si los conteos
  // globales siguen cuadrando por casualidad.
  const planReferencedCompanyIds = plan.groups.flatMap((g) => [g.canonicalCompanyId, ...g.duplicateCompanyIds]);
  const missingPlanCompanyIds = planReferencedCompanyIds.filter((id) => !cohortIds.has(id));

  const recomputedHash = computeSnapshotHash(cohort);
  const diffs = idsMatchApprovedSet ? diffCompanySnapshots(plan.companiesSnapshot, cohort) : [{ issue: "id_set_mismatch" }];

  const allCompanyIds = cohort.map((c) => c.id);
  const leads = allCompanyIds.length > 0 ? await prisma.lead.findMany({ where: { companyId: { in: allCompanyIds } } }) : [];
  const approvedLeadIds = new Set(
    plan.groups.flatMap((g) => [g.survivingLeadId, ...g.leadIdsToRemove].filter(Boolean)),
  );
  const leadIdsMatch = leads.length === approvedLeadIds.size && leads.every((l) => approvedLeadIds.has(l.id));

  const existingContactPointsForCohort =
    approvedCanonicalIds.length > 0
      ? await prisma.companyContactPoint.count({ where: { companyId: { in: approvedCanonicalIds } } })
      : 0;

  const companiesWithNonNullDiscoveryMetadata = await prisma.company.count({
    where: { id: { in: allCompanyIds }, NOT: { discoveryMetadata: { equals: null } } },
  });

  const relationCounts = allCompanyIds.length > 0 ? await loadRelationCounts(prisma, allCompanyIds) : {
    contacts: 0, opportunities: 0, campaignCompanies: 0, jobOrders: 0, projects: 0, invoices: 0, contracts: 0,
  };
  const unexpectedRelationRows = sumUnexpectedRelations(relationCounts);

  const companyDeletesCount = plan.groups.reduce((sum, g) => sum + g.duplicateCompanyIds.length, 0);
  const leadDeletesCount = plan.groups.reduce((sum, g) => sum + g.leadIdsToRemove.length, 0);
  const contactPointsCount = plan.groups.reduce((sum, g) => sum + g.contactPointProposals.length, 0);

  const actual = {
    tenantId: cohort.every((c) => c.tenantId === args["tenant-id"]) ? args["tenant-id"] : "MISMATCH",
    missionTaskId: plan.missionTaskId === args["mission-task-id"] ? args["mission-task-id"] : "MISMATCH",
    snapshotHash: recomputedHash,
    companiesCount: cohort.length,
    groupsCount: plan.groups.length,
    companyDeletesCount,
    leadsCount: leads.length,
    leadDeletesCount,
    contactPointsCount,
    existingContactPointsForCohort,
    companiesWithNonNullDiscoveryMetadata,
    unexpectedRelationRows,
  };
  const expected = {
    tenantId: args["tenant-id"],
    missionTaskId: args["mission-task-id"],
    snapshotHash: args["snapshot-hash"],
    companiesCount: Number(args["expected-companies"]),
    groupsCount: Number(args["expected-groups"]),
    companyDeletesCount: Number(args["expected-company-deletes"]),
    leadsCount: Number(args["expected-leads"]),
    leadDeletesCount: Number(args["expected-lead-deletes"]),
    contactPointsCount: Number(args["expected-contact-points"]),
  };

  const guardReport = buildGuardReport(actual, expected);
  if (!idsMatchApprovedSet) guardReport.failures.push({ check: "companyIdSet", expected: "matches plan", actual: "diverges from plan" });
  if (!leadIdsMatch) guardReport.failures.push({ check: "leadIdSet", expected: "matches plan", actual: "diverges from plan" });
  if (missingPlanCompanyIds.length > 0) {
    guardReport.failures.push({ check: "planReferencedCompanyIds", expected: "all present in cohort", actual: `missing: ${missingPlanCompanyIds.join(", ")}` });
  }
  const ok = guardReport.failures.length === 0;

  return {
    alreadyApplied: false,
    ok,
    failures: guardReport.failures,
    diffs,
    actual,
    expected,
    cohort,
    leads,
    plan,
  };
}

function printSummary(label, obj) {
  console.log(`\n${label}`);
  for (const [k, v] of Object.entries(obj)) console.log(`  ${k}: ${v}`);
}

/**
 * Toda la escritura real, dentro de una única transacción Prisma —
 * exportada por separado para que los tests puedan ejercitarla contra un
 * fixture desechable sin pasar por CLI parsing/process.exit(). Cualquier
 * excepción lanzada dentro de esta función revierte el 100% de los
 * cambios (Prisma hace ROLLBACK automático de `$transaction` ante una
 * promesa rechazada).
 */
export async function runBackfillTransaction(prisma, plan, args) {
  return prisma.$transaction(async (tx) => {
    // 1. Revalidar snapshot dentro de la transacción (defensa contra
    // condiciones de carrera entre la evaluación de arriba y este punto).
    const freshCohort = await loadCohort(tx, plan.discoverTaskIds);
    const freshHash = computeSnapshotHash(freshCohort);
    if (freshHash !== plan.snapshotHash) {
      throw new Error(`Snapshot cambió justo antes de escribir (hash esperado ${plan.snapshotHash}, actual ${freshHash}) — abortando.`);
    }

    const now = new Date();
    let discoveryMetadataWritten = 0;
    let contactPointsCreated = 0;
    let activitiesReassigned = 0;
    let leadsReassigned = 0;
    let leadsDeleted = 0;
    let companiesDeleted = 0;

    for (const group of plan.groups) {
      // 2. discoveryMetadata en la canónica.
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

      // 4. Fusión de campos faltantes en la canónica — no-op verificado
      // para esta cohorte (§5 del plan: cero divergencia de campos
      // dentro de cada grupo, confirmado por el hash de arriba, que
      // cubre exactamente website/phone/email/sourceUrl/industryId).
      // Se deja el paso presente por completitud del diseño general.

      // 5. Reasignar Activities de Company duplicadas → canónica.
      if (group.companyActivityIdsToReassign.length > 0) {
        await tx.activity.updateMany({
          where: { id: { in: group.companyActivityIdsToReassign } },
          data: { entityId: group.canonicalCompanyId },
        });
        activitiesReassigned += group.companyActivityIdsToReassign.length;
      }

      // 6. Consolidar Leads: reasignar el Lead sobreviviente si no
      // apunta ya a la canónica.
      if (group.survivingLeadId) {
        const survivingLead = await tx.lead.findUnique({ where: { id: group.survivingLeadId } });
        if (survivingLead && survivingLead.companyId !== group.canonicalCompanyId) {
          await tx.lead.update({ where: { id: group.survivingLeadId }, data: { companyId: group.canonicalCompanyId } });
          leadsReassigned++;
        }
      }

      // Reasignar Activities del Lead (de los Leads a eliminar) hacia
      // el Lead sobreviviente, ANTES de eliminar esos Leads.
      if (group.leadActivityIdsToReassign.length > 0 && group.survivingLeadId) {
        await tx.activity.updateMany({
          where: { id: { in: group.leadActivityIdsToReassign } },
          data: { entityId: group.survivingLeadId },
        });
        activitiesReassigned += group.leadActivityIdsToReassign.length;
      }
    }

    // 7. Validar que las duplicadas no tengan relaciones pendientes
    // (Contact/Opportunity/CampaignCompany/JobOrder/Project/Invoice/
    // Contract con onDelete RESTRICT) antes de borrar nada.
    const allDuplicateCompanyIds = plan.groups.flatMap((g) => g.duplicateCompanyIds);
    if (allDuplicateCompanyIds.length > 0) {
      const relCounts = await loadRelationCounts(tx, allDuplicateCompanyIds);
      const blocking = sumUnexpectedRelations(relCounts);
      if (blocking > 0) {
        throw new Error(
          `Las Companies duplicadas todavía tienen ${blocking} relación(es) bloqueante(s) sin reasignar — abortando antes de eliminar. Detalle: ${JSON.stringify(relCounts)}`,
        );
      }
    }

    // 8. Eliminar los Leads duplicados (ya sin Activities propias — se
    // reasignaron en el paso 6).
    const allLeadIdsToRemove = plan.groups.flatMap((g) => g.leadIdsToRemove);
    if (allLeadIdsToRemove.length > 0) {
      const del = await tx.lead.deleteMany({ where: { id: { in: allLeadIdsToRemove } } });
      leadsDeleted = del.count;
    }

    // 9. Eliminar las Companies duplicadas (ahora seguro: sin Leads,
    // sin Activities propias, sin ninguna relación RESTRICT pendiente).
    if (allDuplicateCompanyIds.length > 0) {
      const del = await tx.company.deleteMany({ where: { id: { in: allDuplicateCompanyIds } } });
      companiesDeleted = del.count;
    }

    // 10. Post-validación dentro de la misma transacción — si algo no
    // cuadra, lanzar para forzar ROLLBACK antes del commit.
    const finalCompanies = await tx.company.count({ where: { discoveredByAgentTaskId: { in: plan.discoverTaskIds } } });
    if (finalCompanies !== plan.groups.length) {
      throw new Error(`Post-validación falló: se esperaban ${plan.groups.length} Companies finales, hay ${finalCompanies}.`);
    }
    const finalLeads = await tx.lead.count({
      where: { companyId: { in: plan.groups.map((g) => g.canonicalCompanyId) } },
    });
    if (finalLeads !== plan.groups.length) {
      throw new Error(`Post-validación falló: se esperaban ${plan.groups.length} Leads finales, hay ${finalLeads}.`);
    }
    // Defensa adicional (en principio imposible: Lead.companyId tiene
    // onDelete SET NULL, así que Postgres ya garantiza que ningún Lead
    // puede seguir apuntando a una Company recién eliminada) — se
    // verifica de todas formas, explícito, antes del commit.
    const danglingLeads = await tx.lead.count({ where: { companyId: { in: allDuplicateCompanyIds } } });
    if (danglingLeads > 0) {
      throw new Error(`Post-validación falló: ${danglingLeads} Lead(s) todavía apuntan a una Company duplicada eliminada.`);
    }

    return { discoveryMetadataWritten, contactPointsCreated, activitiesReassigned, leadsReassigned, leadsDeleted, companiesDeleted };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const argCheck = validateArgs(args);
  if (!argCheck.ok) {
    console.error(argCheck.reason);
    process.exit(1);
  }

  const plan = loadApprovedPlan();
  if (plan.snapshotHash !== args["snapshot-hash"]) {
    console.error(
      `--snapshot-hash no coincide con el plan aprobado (esperado por el plan: ${plan.snapshotHash}, recibido: ${args["snapshot-hash"]}).`,
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  let exitCode = 0;
  try {
    const evaluation = await evaluateCohort(prisma, plan, args);

    if (evaluation.alreadyApplied) {
      console.log(evaluation.message);
      printSummary("Detalle:", evaluation.details);
      process.exit(0);
    }

    if (!evaluation.ok) {
      console.error("BLOCKERS — la ejecución no debe proceder:");
      console.error(JSON.stringify(evaluation.failures, null, 2));
      if (evaluation.diffs && evaluation.diffs.length > 0) {
        console.error("\nDiferencias encontradas contra el snapshot aprobado (primeras 20):");
        console.error(JSON.stringify(evaluation.diffs.slice(0, 20), null, 2));
      }
      process.exit(1);
    }

    printSummary("Antes:", {
      Companies: evaluation.actual.companiesCount,
      Groups: evaluation.actual.groupsCount,
      Leads: evaluation.actual.leadsCount,
      CompanyContactPoint: evaluation.actual.existingContactPointsForCohort,
    });
    printSummary("Después esperado:", {
      "Companies canónicas": evaluation.expected.groupsCount,
      "Companies eliminadas": evaluation.expected.companyDeletesCount,
      "Leads canónicos": evaluation.expected.groupsCount,
      "Leads eliminados": evaluation.expected.leadDeletesCount,
      "CompanyContactPoint creados": evaluation.expected.contactPointsCount,
      "Activities reasignadas": plan.groups.reduce(
        (sum, g) => sum + g.companyActivityIdsToReassign.length + g.leadActivityIdsToReassign.length,
        0,
      ),
      "discoveryMetadata escrito": evaluation.expected.groupsCount,
    });

    if (!args.execute) {
      console.log("\nDRY-RUN REFORZADO — sin --execute, cero escrituras. Todas las guardas pasaron.");
      process.exit(0);
    }

    console.log("\n--execute recibido — abriendo transacción de escritura...");
    const result = await runBackfillTransaction(prisma, plan, args);

    printSummary("Resultado real:", {
      "discoveryMetadata escrito": result.discoveryMetadataWritten,
      "CompanyContactPoint creados": result.contactPointsCreated,
      "Activities reasignadas": result.activitiesReassigned,
      "Leads reasignados a canónica": result.leadsReassigned,
      "Leads eliminados": result.leadsDeleted,
      "Companies eliminadas": result.companiesDeleted,
    });
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

// Solo correr main() si el archivo se invoca directamente (no cuando un
// test lo importa para reusar parseArgs/validateArgs/evaluateCohort).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { parseArgs };
