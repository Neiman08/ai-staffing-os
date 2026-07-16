// Estabilización de la cohorte de Illinois (Opción C, aprobada) — crea
// AgentMemory (entityType="company") para las Companies que el
// scheduler de prospección todavía considera elegibles, para que deje
// de crearles Leads/Opportunities/AgentTasks/Activities mientras se
// rediseña el backfill de deduplicación (75→29). Ver
// docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md e
// apps/api/src/modules/agents/{scheduler,memory}.ts para el contexto
// completo del hallazgo que motiva este script.
//
// SEGURO POR DEFECTO: sin --execute, este script SOLO lee — cero
// escrituras. Con --execute, corre toda la creación dentro de una
// única transacción Prisma — cualquier error revierte el 100% de los
// cambios. NO toca Company/Lead/Opportunity/Activity/AgentTask/
// Contact/CompanyContactPoint/discoveryMetadata/Campaign/JobOrder/
// Project/Assignment/Invoice/Payment/Tenant.settings, ni el código del
// scheduler.
//
// Uso (dry-run, recomendado primero):
//   node --import tsx packages/db/scripts/stabilize-illinois-cohort.mjs \
//     --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
//     --expected-eligible=59
//
// Uso (ejecución real, solo tras confirmar el resultado del dry-run):
//   agregar --execute

import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  buildStabilizationGuardReport,
  buildStabilizationMemoryData,
  computeEligibleCompanies,
  loadCohortCompanies,
  loadExistingCompanyMemories,
  resolveDiscoverTaskIds,
  resolveProspectingAgentInstanceId,
} from "./illinois-stabilization-lib.mjs";

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

const REQUIRED_ARGS = ["tenant-id", "mission-task-id", "expected-eligible"];

export function validateArgs(args) {
  const missing = REQUIRED_ARGS.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `Argumentos requeridos faltantes: ${missing.map((m) => `--${m}`).join(", ")}` };
  }
  return { ok: true };
}

/**
 * Evalúa el estado real de la cohorte — no escribe nada. Usado tanto
 * por el dry-run como por el primer paso (fuera de la transacción) de
 * la ejecución real.
 */
export async function evaluateStabilization(prisma, args) {
  const tenantId = args["tenant-id"];
  const missionTaskId = args["mission-task-id"];
  const expectedEligible = Number(args["expected-eligible"]);

  const discoverTaskIds = await resolveDiscoverTaskIds(prisma, tenantId, missionTaskId);
  const cohort = await loadCohortCompanies(prisma, discoverTaskIds);
  const cohortIds = cohort.map((c) => c.id);
  const existingMemories = await loadExistingCompanyMemories(prisma, cohortIds);
  const eligible = computeEligibleCompanies(cohort, existingMemories.map((m) => m.entityId));

  // Idempotencia — estado real, nunca una bandera manual: si no queda
  // ninguna Company elegible, no hay nada que hacer, sin importar qué
  // --expected-eligible se haya pasado.
  if (cohort.length > 0 && eligible.length === 0) {
    return {
      alreadyApplied: true,
      message: "No quedan Companies elegibles para esta cohorte — la estabilización ya fue aplicada o no hay nada que estabilizar.",
      details: { cohortCompaniesCount: cohort.length, preexistingMemoriesCount: existingMemories.length },
    };
  }

  const actualTenantId = cohort.every((c) => c.tenantId === tenantId) ? tenantId : "MISMATCH";
  const guardReport = buildStabilizationGuardReport(
    { tenantId: actualTenantId, eligibleCount: eligible.length },
    { tenantId, eligibleCount: expectedEligible },
  );

  return {
    alreadyApplied: false,
    ok: guardReport.ok,
    failures: guardReport.failures,
    tenantId,
    missionTaskId,
    discoverTaskIds,
    cohort,
    eligible,
    existingMemories,
  };
}

/**
 * Toda la escritura real, dentro de una única transacción Prisma —
 * exportada por separado para que los tests puedan ejercitarla contra
 * un fixture desechable. Cualquier excepción revierte el 100% de los
 * cambios (ROLLBACK automático de Prisma ante una promesa rechazada).
 * Orden exacto (Regla 4 del PO): 1) recomputar elegibles; 2) confirmar
 * el conteo esperado; 3) confirmar que las Companies ya procesadas
 * conservan su AgentMemory; 4) crear las nuevas; 5) validar
 * cohort=memorias; 6) validar cero elegibles restantes; 7) devolver
 * (commit lo hace Prisma al resolver la promesa).
 */
export async function runStabilizationTransaction(
  prisma,
  { tenantId, missionTaskId, agentInstanceId, discoverTaskIds, expectedEligible, expectedPreexistingIds },
) {
  return prisma.$transaction(async (tx) => {
    // 1. Recomputar en fresco dentro de la transacción (defensa contra
    // condiciones de carrera entre evaluateStabilization() y este punto).
    const freshCohort = await loadCohortCompanies(tx, discoverTaskIds);
    const freshExisting = await loadExistingCompanyMemories(tx, freshCohort.map((c) => c.id));
    const freshEligible = computeEligibleCompanies(freshCohort, freshExisting.map((m) => m.entityId));

    // 2. Confirmar el conteo exacto esperado.
    if (freshEligible.length !== expectedEligible) {
      throw new Error(
        `La cohorte cambió justo antes de escribir (elegibles esperados ${expectedEligible}, reales ${freshEligible.length}) — abortando.`,
      );
    }

    // 3. Confirmar que las Companies previamente procesadas siguen
    // teniendo su AgentMemory intacta (nunca se tocan ni se recrean).
    const freshExistingIds = new Set(freshExisting.map((m) => m.entityId));
    const missingPreexisting = expectedPreexistingIds.filter((id) => !freshExistingIds.has(id));
    if (missingPreexisting.length > 0) {
      throw new Error(
        `${missingPreexisting.length} Company(s) previamente procesada(s) ya no tienen AgentMemory — abortando: ${missingPreexisting.join(", ")}`,
      );
    }

    // 4. Crear una AgentMemory de estabilización por Company elegible.
    const now = new Date();
    const created = [];
    for (const company of freshEligible) {
      const row = await tx.agentMemory.create({
        data: buildStabilizationMemoryData({ tenantId, agentInstanceId, companyId: company.id, missionTaskId, createdAt: now }),
      });
      created.push(row);
    }

    // 5. Validar que la cohorte termina con una AgentMemory por Company.
    const postExisting = await loadExistingCompanyMemories(tx, freshCohort.map((c) => c.id));
    if (postExisting.length !== freshCohort.length) {
      throw new Error(
        `Post-validación falló: se esperaban ${freshCohort.length} AgentMemory para la cohorte, hay ${postExisting.length}.`,
      );
    }

    // 6. Validar que ninguna Company sigue elegible.
    const remainingEligible = computeEligibleCompanies(freshCohort, postExisting.map((m) => m.entityId));
    if (remainingEligible.length !== 0) {
      throw new Error(`Post-validación falló: quedan ${remainingEligible.length} Company(s) todavía elegible(s) tras la escritura.`);
    }

    return {
      createdCount: created.length,
      createdIds: created.map((r) => r.id),
      createdCompanyIds: freshEligible.map((c) => c.id),
      cohortCompaniesCount: freshCohort.length,
      totalMemoriesAfter: postExisting.length,
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

  const prisma = new PrismaClient();
  let exitCode = 0;
  try {
    const evaluation = await evaluateStabilization(prisma, args);

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

    printSummary("Estado actual:", {
      "Companies en la cohorte": evaluation.cohort.length,
      "AgentMemory ya existentes": evaluation.existingMemories.length,
      "Companies elegibles a estabilizar": evaluation.eligible.length,
    });

    if (!args.execute) {
      console.log("\nDRY-RUN — sin --execute, cero escrituras. Todas las guardas pasaron.");
      process.exit(0);
    }

    const agentInstanceId = await resolveProspectingAgentInstanceId(prisma, evaluation.tenantId);
    console.log(`\nAgentInstance del Prospecting Agent resuelto: ${agentInstanceId}`);
    console.log("--execute recibido — abriendo transacción de escritura...");

    const result = await runStabilizationTransaction(prisma, {
      tenantId: evaluation.tenantId,
      missionTaskId: evaluation.missionTaskId,
      agentInstanceId,
      discoverTaskIds: evaluation.discoverTaskIds,
      expectedEligible: evaluation.eligible.length,
      expectedPreexistingIds: evaluation.existingMemories.map((m) => m.entityId),
    });

    printSummary("Resultado real:", {
      "AgentMemory creadas": result.createdCount,
      "Companies en la cohorte": result.cohortCompaniesCount,
      "AgentMemory totales tras la escritura": result.totalMemoriesAfter,
    });
    console.log("\nIDs de las AgentMemory creadas:");
    console.log(JSON.stringify(result.createdIds, null, 2));
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
