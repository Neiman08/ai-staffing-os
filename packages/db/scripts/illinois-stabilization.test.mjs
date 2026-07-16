// Tests de la estabilización de la cohorte de Illinois (Opción C). Las
// pruebas de integración usan un fixture SINTÉTICO Y DESECHABLE,
// completamente aislado de la cohorte real de 75/59 Companies de la
// misión de Illinois — nunca se toca esa cohorte real en ningún test.
// No se mezclan con los tests del backfill (illinois-backfill.test.mjs)
// ni con una futura corrección del scheduler — ver
// docs/ILLINOIS_COMPANY_BACKFILL_PLAN.md para el contexto completo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  STABILIZATION_MARKER,
  buildStabilizationContent,
  buildStabilizationMemoryData,
  computeEligibleCompanies,
  buildStabilizationGuardReport,
  loadCohortCompanies,
  loadExistingCompanyMemories,
} from "./illinois-stabilization-lib.mjs";
import { parseArgs, validateArgs, evaluateStabilization, runStabilizationTransaction } from "./stabilize-illinois-cohort.mjs";

const prisma = new PrismaClient();
const FIXTURE_TENANT = "ILLINOIS-STABILIZATION-TEST-TENANT";
const FIXTURE_PREFIX = "ILLINOIS-STABILIZATION-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";

let agentInstanceId;
const createdCompanyIds = [];
const createdLeadIds = [];
const createdMemoryIds = [];
const createdTaskIds = [];

before(async () => {
  const definition = await prisma.agentDefinition.findUnique({ where: { key: "prospecting" }, select: { id: true } });
  assert.ok(definition, "Se esperaba encontrar el AgentDefinition real con key=prospecting");

  const instance = await prisma.agentInstance.create({
    data: { tenantId: FIXTURE_TENANT, definitionId: definition.id },
  });
  agentInstanceId = instance.id;
});

after(async () => {
  if (createdMemoryIds.length > 0) await prisma.agentMemory.deleteMany({ where: { id: { in: createdMemoryIds } } });
  if (createdLeadIds.length > 0) await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  if (createdTaskIds.length > 0) await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  if (agentInstanceId) await prisma.agentInstance.deleteMany({ where: { id: agentInstanceId } });
  await prisma.$disconnect();
});

/**
 * Crea una cohorte sintética fresca: un AgentTask hijo tipo
 * "discover_companies", `eligibleCount` Companies elegibles (LEAD, sin
 * AgentMemory) y `preexistingCount` Companies ya "procesadas" (con su
 * propia AgentMemory real, como la dejaría el scheduler real). Cada
 * Company elegible tiene un Lead propio, para poder verificar que la
 * estabilización no los toca.
 */
async function createFixtureCohort(suffix, { eligibleCount, preexistingCount = 0 }) {
  // Cada cohorte de fixture tiene su propia misión raíz — así
  // resolveDiscoverTaskIds(tenantId, missionTaskId) de un test nunca
  // recoge las Companies dejadas por la cohorte de otro test.
  const missionTask = await prisma.agentTask.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, type: "mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  createdTaskIds.push(missionTask.id);
  const missionTaskId = missionTask.id;

  const discoverTask = await prisma.agentTask.create({
    data: {
      tenantId: FIXTURE_TENANT,
      agentInstanceId,
      type: "discover_companies",
      parentTaskId: missionTaskId,
      input: {},
      status: "DONE",
      triggeredBy: "AGENT",
    },
  });
  createdTaskIds.push(discoverTask.id);

  const eligible = [];
  const preexisting = [];
  for (let i = 0; i < eligibleCount; i++) {
    const company = await prisma.company.create({
      data: {
        tenantId: FIXTURE_TENANT,
        name: `${FIXTURE_PREFIX} ${suffix} Eligible ${i}`,
        industryId: REAL_INDUSTRY,
        status: "LEAD",
        origin: "API_PROVIDER",
        discoveredByAgentTaskId: discoverTask.id,
      },
    });
    createdCompanyIds.push(company.id);
    const lead = await prisma.lead.create({
      data: { tenantId: FIXTURE_TENANT, companyId: company.id, industryId: REAL_INDUSTRY, status: "NEW" },
    });
    createdLeadIds.push(lead.id);
    eligible.push(company);
  }
  for (let i = 0; i < preexistingCount; i++) {
    const company = await prisma.company.create({
      data: {
        tenantId: FIXTURE_TENANT,
        name: `${FIXTURE_PREFIX} ${suffix} Preexisting ${i}`,
        industryId: REAL_INDUSTRY,
        status: "LEAD",
        origin: "API_PROVIDER",
        discoveredByAgentTaskId: discoverTask.id,
      },
    });
    createdCompanyIds.push(company.id);
    const memory = await prisma.agentMemory.create({
      data: {
        tenantId: FIXTURE_TENANT,
        agentInstanceId,
        scope: "ENTITY",
        entityType: "company",
        entityId: company.id,
        content: "Procesada por el pipeline: lead fake, opportunity fake, follow-up fake.",
        importance: 0.5,
      },
    });
    createdMemoryIds.push(memory.id);
    preexisting.push({ company, memory });
  }
  return { missionTaskId, discoverTaskIds: [discoverTask.id], eligible, preexisting };
}

// ---------- Unidad — funciones puras ----------

test("computeEligibleCompanies excluye status no LEAD/PROSPECT y companies ya procesadas", () => {
  const companies = [
    { id: "a", status: "LEAD" },
    { id: "b", status: "PROSPECT" },
    { id: "c", status: "CONVERTED" },
    { id: "d", status: "LEAD" },
  ];
  const eligible = computeEligibleCompanies(companies, ["d"]);
  assert.deepEqual(eligible.map((c) => c.id).sort(), ["a", "b"]);
});

test("buildStabilizationContent incluye el marcador, la razón, el missionTaskId y NO afirma prospección real", () => {
  const content = buildStabilizationContent({ missionTaskId: "task-1", createdAt: new Date("2026-07-15T12:00:00Z") });
  assert.ok(content.includes(STABILIZATION_MARKER));
  assert.ok(content.includes("mission_restrictions_and_pending_dedup_backfill"));
  assert.ok(content.includes("missionTaskId=task-1"));
  assert.ok(content.includes("NO fue prospectada realmente"));
});

test("buildStabilizationMemoryData reutiliza exactamente la forma de markCompanyProcessed", () => {
  const data = buildStabilizationMemoryData({
    tenantId: "t1",
    agentInstanceId: "ai1",
    companyId: "c1",
    missionTaskId: "m1",
    createdAt: new Date(),
  });
  assert.equal(data.scope, "ENTITY");
  assert.equal(data.entityType, "company");
  assert.equal(data.entityId, "c1");
  assert.equal(data.importance, 0.5);
  assert.equal(typeof data.content, "string");
});

test("buildStabilizationGuardReport detecta un conteo de elegibles distinto al esperado", () => {
  const report = buildStabilizationGuardReport({ tenantId: "t1", eligibleCount: 3 }, { tenantId: "t1", eligibleCount: 59 });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].check, "eligibleCount");
  assert.equal(report.failures[0].expected, 59);
  assert.equal(report.failures[0].actual, 3);
});

test("parseArgs/validateArgs exigen tenant-id, mission-task-id y expected-eligible", () => {
  const args = parseArgs(["--tenant-id=t1", "--expected-eligible=5"]);
  const check = validateArgs(args);
  assert.equal(check.ok, false);
  assert.ok(check.reason.includes("mission-task-id"));
});

// ---------- Integración — fixture desechable ----------

test("evaluateStabilization detecta exactamente N elegibles y dispara BLOCKERS si el --expected-eligible no coincide", async () => {
  const { missionTaskId, discoverTaskIds } = await createFixtureCohort("eval", { eligibleCount: 3, preexistingCount: 2 });

  const okEval = await evaluateStabilization(prisma, {
    "tenant-id": FIXTURE_TENANT,
    "mission-task-id": missionTaskId,
    "expected-eligible": "3",
  });
  assert.equal(okEval.alreadyApplied, false);
  assert.equal(okEval.ok, true);
  assert.equal(okEval.eligible.length, 3);
  assert.equal(okEval.existingMemories.length, 2);
  assert.deepEqual(okEval.discoverTaskIds, discoverTaskIds);

  const mismatchEval = await evaluateStabilization(prisma, {
    "tenant-id": FIXTURE_TENANT,
    "mission-task-id": missionTaskId,
    "expected-eligible": "999",
  });
  assert.equal(mismatchEval.ok, false);
  assert.deepEqual(mismatchEval.failures, [{ check: "eligibleCount", expected: 999, actual: 3 }]);
});

test("runStabilizationTransaction crea exactamente N AgentMemory, no toca las preexistentes, y Lead/Company quedan intactos", async () => {
  const { missionTaskId, discoverTaskIds, eligible, preexisting } = await createFixtureCohort("write", { eligibleCount: 4, preexistingCount: 2 });
  const preexistingIds = preexisting.map((p) => p.memory.entityId);

  const leadsBefore = await prisma.lead.count({ where: { companyId: { in: eligible.map((c) => c.id) } } });

  const result = await runStabilizationTransaction(prisma, {
    tenantId: FIXTURE_TENANT,
    missionTaskId,
    agentInstanceId,
    discoverTaskIds,
    expectedEligible: 4,
    expectedPreexistingIds: preexistingIds,
  });
  createdMemoryIds.push(...result.createdIds);

  assert.equal(result.createdCount, 4);
  assert.deepEqual(result.createdCompanyIds.sort(), eligible.map((c) => c.id).sort());
  assert.equal(result.totalMemoriesAfter, 6); // 4 nuevas + 2 preexistentes

  // Las preexistentes no fueron tocadas (mismo id, mismo content).
  for (const { memory } of preexisting) {
    const stillThere = await prisma.agentMemory.findUnique({ where: { id: memory.id } });
    assert.ok(stillThere);
    assert.equal(stillThere.content, memory.content);
  }

  // Las nuevas tienen la forma correcta y el marcador de reversibilidad.
  const created = await prisma.agentMemory.findMany({ where: { id: { in: result.createdIds } } });
  for (const row of created) {
    assert.equal(row.scope, "ENTITY");
    assert.equal(row.entityType, "company");
    assert.equal(row.importance, 0.5);
    assert.ok(row.content.includes(STABILIZATION_MARKER));
    assert.ok(eligible.some((c) => c.id === row.entityId));
  }

  // No se creó ni eliminó ningún Lead, ninguna Company cambió de estado.
  const leadsAfter = await prisma.lead.count({ where: { companyId: { in: eligible.map((c) => c.id) } } });
  assert.equal(leadsAfter, leadsBefore);
  const companiesAfter = await prisma.company.findMany({ where: { id: { in: eligible.map((c) => c.id) } } });
  assert.ok(companiesAfter.every((c) => c.status === "LEAD"));

  // Después de escribir, ya no queda ninguna Company elegible — idempotencia.
  const reEval = await evaluateStabilization(prisma, {
    "tenant-id": FIXTURE_TENANT,
    "mission-task-id": missionTaskId,
    "expected-eligible": "4",
  });
  assert.equal(reEval.alreadyApplied, true);
  assert.equal(reEval.details.cohortCompaniesCount, 6);
});

test("runStabilizationTransaction revierte 100% si el conteo cambia justo antes de escribir (carrera)", async () => {
  const { missionTaskId, discoverTaskIds, eligible } = await createFixtureCohort("race", { eligibleCount: 2 });

  await assert.rejects(
    () =>
      runStabilizationTransaction(prisma, {
        tenantId: FIXTURE_TENANT,
        missionTaskId,
        agentInstanceId,
        discoverTaskIds,
        expectedEligible: 999, // deliberadamente distinto al real (2)
        expectedPreexistingIds: [],
      }),
    /elegibles esperados 999, reales 2/,
  );

  const memories = await loadExistingCompanyMemories(prisma, eligible.map((c) => c.id));
  assert.equal(memories.length, 0, "no debe haberse creado ninguna AgentMemory tras el rollback");
});

test("runStabilizationTransaction aborta si falta AgentMemory de una Company previamente procesada", async () => {
  const { missionTaskId, discoverTaskIds, eligible } = await createFixtureCohort("missing-preexisting", { eligibleCount: 1 });

  await assert.rejects(
    () =>
      runStabilizationTransaction(prisma, {
        tenantId: FIXTURE_TENANT,
        missionTaskId,
        agentInstanceId,
        discoverTaskIds,
        expectedEligible: 1,
        expectedPreexistingIds: ["a-company-id-that-has-no-memory"],
      }),
    /ya no tienen AgentMemory/,
  );

  const memories = await loadExistingCompanyMemories(prisma, eligible.map((c) => c.id));
  assert.equal(memories.length, 0, "no debe haberse creado ninguna AgentMemory tras el rollback");
});

test("loadCohortCompanies/loadExistingCompanyMemories devuelven vacío si no hay discoverTaskIds", async () => {
  assert.deepEqual(await loadCohortCompanies(prisma, []), []);
  assert.deepEqual(await loadExistingCompanyMemories(prisma, []), []);
});
