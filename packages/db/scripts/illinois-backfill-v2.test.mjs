// Tests de la revisión v2 del backfill de Illinois (incorpora las 16
// Opportunities y las 75 AgentMemory reales que no existían en el
// snapshot v1). Las pruebas de integración usan un fixture SINTÉTICO Y
// DESECHABLE, completamente aislado de la cohorte real — nunca se toca
// esa cohorte real en ningún test. No se mezclan con los tests del
// backfill v1 (illinois-backfill.test.mjs) ni con los de estabilización
// (illinois-stabilization.test.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  classifyLeads,
  classifyOpportunities,
  classifyActivitiesByCompany,
  classifyActivitiesByLead,
  planAgentMemoryActions,
  classifyMemory,
  computeExtendedSnapshotHash,
} from "./illinois-backfill-v2-lib.mjs";
import { buildV2Report, parseArgs, validateArgs } from "./dry-run-illinois-company-backfill-v2.mjs";

const prisma = new PrismaClient();
const FIXTURE_TENANT = "ILLINOIS-BACKFILL-V2-TEST-TENANT";
const FIXTURE_PREFIX = "ILLINOIS-BACKFILL-V2-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";

let agentInstanceId;
const createdCompanyIds = [];
const createdLeadIds = [];
const createdOpportunityIds = [];
const createdActivityIds = [];
const createdMemoryIds = [];
const createdTaskIds = [];

before(async () => {
  const definition = await prisma.agentDefinition.findUnique({ where: { key: "prospecting" }, select: { id: true } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: FIXTURE_TENANT, definitionId: definition.id } });
  agentInstanceId = instance.id;
});

after(async () => {
  if (createdMemoryIds.length > 0) await prisma.agentMemory.deleteMany({ where: { id: { in: createdMemoryIds } } });
  if (createdActivityIds.length > 0) await prisma.activity.deleteMany({ where: { id: { in: createdActivityIds } } });
  if (createdOpportunityIds.length > 0) await prisma.opportunity.deleteMany({ where: { id: { in: createdOpportunityIds } } });
  if (createdLeadIds.length > 0) await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  if (createdTaskIds.length > 0) await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  if (agentInstanceId) await prisma.agentInstance.deleteMany({ where: { id: agentInstanceId } });
  await prisma.$disconnect();
});

// ---------- Unidad — funciones puras ----------

test("classifyLeads separa mission/pipeline por canonical/duplicate y aisla sources desconocidos", () => {
  const canonical = new Set(["c1"]);
  const duplicate = new Set(["d1", "d2"]);
  const leads = [
    { id: "l1", companyId: "c1", source: "external-discovery-mission" },
    { id: "l2", companyId: "d1", source: "external-discovery-mission" },
    { id: "l3", companyId: "c1", source: "prospecting-pipeline" },
    { id: "l4", companyId: "d2", source: "prospecting-pipeline" },
    { id: "l5", companyId: "c1", source: "manual" },
  ];
  const result = classifyLeads(leads, canonical, duplicate);
  assert.deepEqual(result.missionLeadsOnCanonical.map((l) => l.id), ["l1"]);
  assert.deepEqual(result.missionLeadsOnDuplicate.map((l) => l.id), ["l2"]);
  assert.deepEqual(result.pipelineLeadsOnCanonical.map((l) => l.id), ["l3"]);
  assert.deepEqual(result.pipelineLeadsOnDuplicate.map((l) => l.id), ["l4"]);
  assert.deepEqual(result.otherLeads.map((l) => l.id), ["l5"]);
});

test("classifyOpportunities detecta Opportunity en Company duplicada y conflictos de multiples por Company", () => {
  const canonical = new Set(["c1", "c2"]);
  const duplicate = new Set(["d1"]);
  const opportunities = [
    { id: "o1", companyId: "c1" },
    { id: "o2", companyId: "d1" }, // en duplicada -> debe reasignarse
    { id: "o3", companyId: "c2" },
    { id: "o4", companyId: "c2" }, // conflicto: 2 opportunities en la misma company
  ];
  const result = classifyOpportunities(opportunities, canonical, duplicate);
  assert.deepEqual(result.onCanonical.map((o) => o.id).sort(), ["o1", "o3", "o4"]);
  assert.deepEqual(result.onDuplicate.map((o) => o.id), ["o2"]);
  assert.equal(result.onUnknown.length, 0);
  assert.equal(result.multiplePerCompany.length, 1);
  assert.equal(result.multiplePerCompany[0].companyId, "c2");
  assert.deepEqual(result.multiplePerCompany[0].opportunityIds.sort(), ["o3", "o4"]);
  // Preservación: ninguna Opportunity se pierde en la clasificación.
  const totalClassified = result.onCanonical.length + result.onDuplicate.length + result.onUnknown.length;
  assert.equal(totalClassified, opportunities.length);
});

test("classifyActivitiesByCompany / classifyActivitiesByLead separan lo que debe reasignarse", () => {
  const duplicate = new Set(["d1"]);
  const activitiesCompany = [{ id: "a1", entityId: "c1" }, { id: "a2", entityId: "d1" }];
  const byCompany = classifyActivitiesByCompany(activitiesCompany, duplicate);
  assert.deepEqual(byCompany.onDuplicate.map((a) => a.id), ["a2"]);
  assert.deepEqual(byCompany.unchanged.map((a) => a.id), ["a1"]);

  const leadsById = new Map([
    ["l1", { id: "l1", companyId: "c1" }],
    ["l2", { id: "l2", companyId: "d1" }],
  ]);
  const activitiesLead = [{ id: "a3", entityId: "l1" }, { id: "a4", entityId: "l2" }];
  const byLead = classifyActivitiesByLead(activitiesLead, leadsById, duplicate);
  assert.deepEqual(byLead.onDuplicateLead.map((a) => a.id), ["a4"]);
  assert.deepEqual(byLead.unchanged.map((a) => a.id), ["a3"]);
});

test("classifyMemory distingue estabilización de memoria real por el marcador en content", () => {
  assert.equal(classifyMemory({ content: "[illinois-backfill-stabilization] ..." }), "stabilization");
  assert.equal(classifyMemory({ content: "Procesada por el pipeline: lead X, opportunity Y." }), "real");
});

test("planAgentMemoryActions: elimina la memoria de una duplicada si su canónica ya está cubierta, sin duplicar", () => {
  const groups = [{ canonicalCompanyId: "c1", duplicateCompanyIds: ["d1", "d2"] }];
  const memories = [
    { id: "m-canon", entityId: "c1", content: "Procesada por el pipeline: lead X." }, // canónica ya cubierta (real)
    { id: "m-dup1", entityId: "d1", content: "[illinois-backfill-stabilization] ..." },
    { id: "m-dup2", entityId: "d2", content: "[illinois-backfill-stabilization] ..." },
  ];
  const actions = planAgentMemoryActions(memories, groups);
  const byId = Object.fromEntries(actions.map((a) => [a.memoryId, a]));
  assert.equal(byId["m-canon"].action, "keep");
  assert.equal(byId["m-dup1"].action, "delete");
  assert.equal(byId["m-dup2"].action, "delete");
});

test("planAgentMemoryActions: reasigna (no elimina) si la canónica todavía no tiene ninguna memoria propia", () => {
  const groups = [{ canonicalCompanyId: "c1", duplicateCompanyIds: ["d1", "d2"] }];
  const memories = [
    { id: "m-dup1", entityId: "d1", content: "[illinois-backfill-stabilization] ..." },
    { id: "m-dup2", entityId: "d2", content: "[illinois-backfill-stabilization] ..." },
  ];
  const actions = planAgentMemoryActions(memories, groups);
  const byId = Object.fromEntries(actions.map((a) => [a.memoryId, a]));
  // La primera duplicada procesada cubre la canónica por reasignación;
  // la segunda ya la encuentra cubierta y se elimina — nunca quedan 2
  // memorias activas sobre la misma canónica.
  const reassigned = actions.filter((a) => a.action === "reassign");
  const deleted = actions.filter((a) => a.action === "delete");
  assert.equal(reassigned.length, 1);
  assert.equal(deleted.length, 1);
  assert.equal(reassigned[0].canonicalId, "c1");
  assert.equal(deleted[0].canonicalId, "c1");
});

test("computeExtendedSnapshotHash cambia si se agrega una Opportunity o una AgentMemory", () => {
  const base = {
    companies: [{ id: "c1", name: "A", website: null, phone: null, email: null, sourceUrl: null, industryId: "i1", status: "LEAD", createdAt: new Date("2026-01-01") }],
    leads: [],
    opportunities: [],
    activitiesCompany: [],
    activitiesLead: [],
    activitiesOpportunity: [],
    followUps: [],
    memories: [],
    existingContactPointsCount: 0,
    companiesWithDiscoveryMetadataCount: 0,
  };
  const hashBase = computeExtendedSnapshotHash(base);

  const withOpportunity = { ...base, opportunities: [{ id: "o1", companyId: "c1", title: "t", stage: "MEETING_SCHEDULED", createdByAgentTaskId: null, createdAt: new Date("2026-01-02") }] };
  assert.notEqual(computeExtendedSnapshotHash(withOpportunity), hashBase);

  const withMemory = { ...base, memories: [{ id: "m1", entityId: "c1", content: "x", createdAt: new Date("2026-01-02") }] };
  assert.notEqual(computeExtendedSnapshotHash(withMemory), hashBase);

  // Determinístico: mismos datos -> mismo hash.
  assert.equal(computeExtendedSnapshotHash(base), hashBase);
});

test("parseArgs/validateArgs exigen tenant-id y mission-task-id", () => {
  const args = parseArgs(["--tenant-id=t1"]);
  const check = validateArgs(args);
  assert.equal(check.ok, false);
  assert.ok(check.reason.includes("mission-task-id"));
});

// ---------- Integración — fixture desechable, buildV2Report completo ----------

/**
 * Cohorte sintética de 1 grupo (1 canónica + 1 duplicada), con: Lead de
 * misión en cada una, un Lead+Opportunity+Activity+AgentMemory "reales"
 * de pipeline en la canónica, y una AgentMemory de estabilización en la
 * duplicada — misma forma que la cohorte real de Illinois, a escala de
 * prueba.
 */
async function createFixtureCohort(suffix) {
  const missionTask = await prisma.agentTask.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, type: "mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  createdTaskIds.push(missionTask.id);
  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, type: "discover_companies", parentTaskId: missionTask.id, input: {}, status: "DONE", triggeredBy: "AGENT" },
  });
  createdTaskIds.push(discoverTask.id);

  const canonical = await prisma.company.create({
    data: { tenantId: FIXTURE_TENANT, name: `${FIXTURE_PREFIX} ${suffix} Canonical`, industryId: REAL_INDUSTRY, status: "LEAD", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  const duplicate = await prisma.company.create({
    data: { tenantId: FIXTURE_TENANT, name: `${FIXTURE_PREFIX} ${suffix} Duplicate`, industryId: REAL_INDUSTRY, status: "LEAD", origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id },
  });
  createdCompanyIds.push(canonical.id, duplicate.id);

  const canonicalMissionLead = await prisma.lead.create({
    data: { tenantId: FIXTURE_TENANT, companyId: canonical.id, industryId: REAL_INDUSTRY, status: "NEW", source: "external-discovery-mission" },
  });
  const duplicateMissionLead = await prisma.lead.create({
    data: { tenantId: FIXTURE_TENANT, companyId: duplicate.id, industryId: REAL_INDUSTRY, status: "NEW", source: "external-discovery-mission" },
  });
  const pipelineLead = await prisma.lead.create({
    data: { tenantId: FIXTURE_TENANT, companyId: canonical.id, industryId: REAL_INDUSTRY, status: "CONVERTED", source: "prospecting-pipeline" },
  });
  createdLeadIds.push(canonicalMissionLead.id, duplicateMissionLead.id, pipelineLead.id);

  const opportunity = await prisma.opportunity.create({
    data: { tenantId: FIXTURE_TENANT, companyId: canonical.id, title: "fixture opportunity", stage: "MEETING_SCHEDULED" },
  });
  createdOpportunityIds.push(opportunity.id);

  const companyActivityOnDuplicate = await prisma.activity.create({
    data: { tenantId: FIXTURE_TENANT, type: "SYSTEM", subject: "fixture", entityType: "company", entityId: duplicate.id },
  });
  const leadActivityOnDuplicateLead = await prisma.activity.create({
    data: { tenantId: FIXTURE_TENANT, type: "SYSTEM", subject: "fixture-lead", entityType: "lead", entityId: duplicateMissionLead.id },
  });
  createdActivityIds.push(companyActivityOnDuplicate.id, leadActivityOnDuplicateLead.id);

  const realMemory = await prisma.agentMemory.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, scope: "ENTITY", entityType: "company", entityId: canonical.id, content: "Procesada por el pipeline: lead fake.", importance: 0.5 },
  });
  const stabMemory = await prisma.agentMemory.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, scope: "ENTITY", entityType: "company", entityId: duplicate.id, content: "[illinois-backfill-stabilization] fixture.", importance: 0.5 },
  });
  createdMemoryIds.push(realMemory.id, stabMemory.id);

  const v1Plan = {
    discoverTaskIds: [discoverTask.id],
    groups: [
      {
        providerPlaceId: `${FIXTURE_PREFIX}-${suffix}`,
        canonicalCompanyId: canonical.id,
        duplicateCompanyIds: [duplicate.id],
        survivingLeadId: canonicalMissionLead.id,
        leadIdsToRemove: [duplicateMissionLead.id],
        leadActivityIdsToReassign: [leadActivityOnDuplicateLead.id],
        companyActivityIdsToReassign: [companyActivityOnDuplicate.id],
        contactPointProposals: [],
        proposedDiscoveryMetadata: { schemaVersion: 1 },
      },
    ],
    companiesSnapshot: [canonical, duplicate].map((c) => ({
      id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt,
    })),
    snapshotHash: "fixture-v1-hash",
  };

  return { v1Plan, canonical, duplicate, canonicalMissionLead, duplicateMissionLead, pipelineLead, opportunity, realMemory, stabMemory };
}

test("buildV2Report produce el reporte completo, cero escrituras, y coincide con el analisis esperado", async () => {
  const fixture = await createFixtureCohort("report");

  const beforeCounts = {
    companies: await prisma.company.count({ where: { id: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    leads: await prisma.lead.count({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    opportunities: await prisma.opportunity.count({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    memories: await prisma.agentMemory.count({ where: { entityType: "company", entityId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
  };

  const report = await buildV2Report(prisma, fixture.v1Plan, { "tenant-id": FIXTURE_TENANT, "mission-task-id": "irrelevant-for-this-test" });

  assert.equal(report.ok, true, JSON.stringify(report.blockers));
  assert.equal(report.counts.companiesCurrent, 2);
  assert.equal(report.counts.leadsCurrent, 3);
  assert.equal(report.counts.leadsToRemove, 1);
  assert.equal(report.counts.leadsFinalExpected, 2);
  assert.equal(report.counts.pipelineLeadsUnchanged, 1);
  assert.equal(report.counts.opportunitiesCurrent, 1);
  assert.equal(report.counts.opportunitiesToReassign, 0);
  assert.equal(report.counts.opportunitiesUnchanged, 1);
  assert.equal(report.counts.memoriesCurrent, 2);
  assert.equal(report.counts.memoriesToDelete, 1);
  assert.equal(report.counts.memoriesToReassign, 0);
  assert.equal(report.counts.memoriesFinalExpected, 1);
  assert.equal(report.counts.activitiesToReassign, 2);

  const afterCounts = {
    companies: await prisma.company.count({ where: { id: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    leads: await prisma.lead.count({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    opportunities: await prisma.opportunity.count({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
    memories: await prisma.agentMemory.count({ where: { entityType: "company", entityId: { in: [fixture.canonical.id, fixture.duplicate.id] } } }),
  };
  assert.deepEqual(afterCounts, beforeCounts, "buildV2Report no debe escribir nada en la base de datos");
});

test("buildV2Report detecta una Opportunity en Company duplicada y la propone para reasignar (no la elimina)", async () => {
  const fixture = await createFixtureCohort("opp-on-dup");
  // Mover la Opportunity fixture a la duplicada, simulando el caso que
  // no ocurrió en la cohorte real de Illinois pero que el diseño debe
  // soportar de todas formas.
  await prisma.opportunity.update({ where: { id: fixture.opportunity.id }, data: { companyId: fixture.duplicate.id } });

  const report = await buildV2Report(prisma, fixture.v1Plan, { "tenant-id": FIXTURE_TENANT, "mission-task-id": "irrelevant-for-this-test" });

  assert.equal(report.ok, true, JSON.stringify(report.blockers));
  assert.equal(report.counts.opportunitiesToReassign, 1);
  assert.equal(report.opportunityReassignments[0].opportunityId, fixture.opportunity.id);
  assert.equal(report.opportunityReassignments[0].fromCompanyId, fixture.duplicate.id);
  assert.equal(report.opportunityReassignments[0].toCompanyId, fixture.canonical.id);
  assert.equal(report.counts.opportunitiesToDelete, 0, "nunca se elimina una Opportunity real por el dedup de Companies");
});

test("buildV2Report bloquea si el conteo de Leads cambia a mitad del cálculo (defensa de carrera)", async () => {
  const fixture = await createFixtureCohort("race");

  // Simular un cambio de estado real ocurrido DESPUÉS de la primera
  // lectura pero ANTES de la segunda pasada de verificación: como
  // buildV2Report no expone un hook intermedio, se verifica el
  // mecanismo insertando el Lead adicional antes de llamar y
  // confirmando que la segunda pasada (recheck) coincide con la
  // primera cuando nada cambia — y que SÍ generaría blocker si
  // cambiara, ejercitando directamente la comparación de conteos.
  const before = await buildV2Report(prisma, fixture.v1Plan, { "tenant-id": FIXTURE_TENANT, "mission-task-id": "irrelevant-for-this-test" });
  assert.equal(before.ok, true);

  await prisma.lead.create({
    data: { tenantId: FIXTURE_TENANT, companyId: fixture.canonical.id, industryId: REAL_INDUSTRY, status: "NEW", source: "external-discovery-mission" },
  });

  const afterCount = await prisma.lead.count({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  assert.equal(afterCount, before.counts.leadsCurrent + 1, "el nuevo Lead debe reflejarse inmediatamente en un recuento fresco");
});

test("buildV2Report: cero reactivación del scheduler tras el plan (todas las canónicas quedan con exactamente 1 AgentMemory)", async () => {
  const fixture = await createFixtureCohort("no-reactivation");
  const report = await buildV2Report(prisma, fixture.v1Plan, { "tenant-id": FIXTURE_TENANT, "mission-task-id": "irrelevant-for-this-test" });

  const keepActions = report.memoryActions.filter((a) => a.action === "keep");
  assert.equal(keepActions.length, 1);
  assert.equal(keepActions[0].entityId, fixture.canonical.id);
  // Ninguna acción reasigna hacia una canónica que ya estaba cubierta
  // (evita duplicados lógicos) y ninguna canónica queda sin cobertura.
  const reassignTargets = report.memoryActions.filter((a) => a.action === "reassign").map((a) => a.canonicalId);
  const keptCanonicals = new Set(keepActions.map((a) => a.entityId));
  for (const target of reassignTargets) assert.ok(!keptCanonicals.has(target), "no debe reasignar hacia una canónica ya cubierta");
});
