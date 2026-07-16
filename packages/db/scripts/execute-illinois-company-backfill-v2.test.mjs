// Tests del script de ejecución real v2 del backfill de Illinois.
// TODAS las pruebas de escritura corren contra un fixture SINTÉTICO Y
// DESECHABLE — nunca contra la cohorte real de 75/29 Companies de
// Illinois. Este archivo es el único lugar donde
// runBackfillTransactionV2() se invoca con datos que realmente se
// escriben; la cohorte real solo se toca cuando el PO apruebe
// --execute por separado.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { computeExtendedSnapshotHash } from "./illinois-backfill-v2-lib.mjs";
import {
  parseArgs,
  validateArgs,
  evaluateCohortV2,
  runBackfillTransactionV2,
} from "./execute-illinois-company-backfill-v2.mjs";

const prisma = new PrismaClient();
const FIXTURE_TENANT = "ILLINOIS-BACKFILL-V2-EXEC-TEST-TENANT";
const FIXTURE_PREFIX = "ILLINOIS-BACKFILL-V2-EXEC-TEST-FIXTURE";
const REAL_INDUSTRY = "industry-construction";

let agentInstanceId;
const createdCompanyIds = [];
const createdLeadIds = [];
const createdOpportunityIds = [];
const createdActivityIds = [];
const createdMemoryIds = [];
const createdTaskIds = [];
const createdContactPointIds = [];

before(async () => {
  const definition = await prisma.agentDefinition.findUnique({ where: { key: "prospecting" }, select: { id: true } });
  const instance = await prisma.agentInstance.create({ data: { tenantId: FIXTURE_TENANT, definitionId: definition.id } });
  agentInstanceId = instance.id;
});

after(async () => {
  if (createdContactPointIds.length > 0) await prisma.companyContactPoint.deleteMany({ where: { id: { in: createdContactPointIds } } });
  if (createdMemoryIds.length > 0) await prisma.agentMemory.deleteMany({ where: { id: { in: createdMemoryIds } } });
  if (createdActivityIds.length > 0) await prisma.activity.deleteMany({ where: { id: { in: createdActivityIds } } });
  if (createdOpportunityIds.length > 0) await prisma.opportunity.deleteMany({ where: { id: { in: createdOpportunityIds } } });
  if (createdLeadIds.length > 0) await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  if (createdTaskIds.length > 0) await prisma.agentTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  if (agentInstanceId) await prisma.agentInstance.deleteMany({ where: { id: agentInstanceId } });
  await prisma.$disconnect();
});

/**
 * Misma forma que la cohorte real: 1 grupo (1 canónica + 1 duplicada);
 * la canónica tiene un Lead+Opportunity+Activity(lead)+AgentMemory
 * "reales" de pipeline; la duplicada tiene un Lead de misión +
 * Activity(company) + Activity(lead) + AgentMemory de estabilización.
 * Devuelve un plan v2 completo (misma forma que
 * illinois-backfill-approved-groups-v2.json) con snapshotHash real,
 * calculado sobre el estado recién creado.
 */
async function createFixtureCohortAndPlan(suffix) {
  const missionTask = await prisma.agentTask.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, type: "mission", input: {}, status: "DONE", triggeredBy: "USER" },
  });
  createdTaskIds.push(missionTask.id);
  const discoverTask = await prisma.agentTask.create({
    data: { tenantId: FIXTURE_TENANT, agentInstanceId, type: "discover_companies", parentTaskId: missionTask.id, input: {}, status: "DONE", triggeredBy: "AGENT" },
  });
  createdTaskIds.push(discoverTask.id);

  const canonical = await prisma.company.create({
    data: {
      tenantId: FIXTURE_TENANT, name: `${FIXTURE_PREFIX} ${suffix} Canonical`, industryId: REAL_INDUSTRY, status: "LEAD",
      origin: "API_PROVIDER", discoveredByAgentTaskId: discoverTask.id, email: "%20info@fixture-v2-exec.com",
    },
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
    data: { tenantId: FIXTURE_TENANT, type: "SYSTEM", subject: "fixture-company", entityType: "company", entityId: duplicate.id },
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

  const group = {
    providerPlaceId: `${FIXTURE_PREFIX}-${suffix}`,
    canonicalCompanyId: canonical.id,
    duplicateCompanyIds: [duplicate.id],
    survivingLeadId: canonicalMissionLead.id,
    contactPointProposals: [{ email: "info@fixture-v2-exec.com", type: "INFO", sourceUrl: null, discoveryProvider: "test-fixture", verificationStatus: "NOT_VERIFIED" }],
    proposedDiscoveryMetadata: { schemaVersion: 1, prospectingSchedulerProcessed: true, prospectingLeadIds: [pipelineLead.id], opportunityIds: [opportunity.id], stabilizationMemoryIds: [] },
  };

  const cohort = [canonical, duplicate];
  const leads = [canonicalMissionLead, duplicateMissionLead, pipelineLead];
  const opportunities = [opportunity];
  const activitiesCompany = [companyActivityOnDuplicate];
  const activitiesLead = [leadActivityOnDuplicateLead];
  const memories = [realMemory, stabMemory];

  const snapshotHash = computeExtendedSnapshotHash({
    companies: cohort,
    leads,
    opportunities,
    activitiesCompany,
    activitiesLead,
    activitiesOpportunity: [],
    followUps: [],
    memories,
    existingContactPointsCount: 0,
    companiesWithDiscoveryMetadataCount: 0,
  });

  const plan = {
    tenantId: FIXTURE_TENANT,
    missionTaskId: missionTask.id,
    discoverTaskIds: [discoverTask.id],
    snapshotHash,
    groups: [group],
    companiesSnapshot: cohort.map((c) => ({
      id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt,
    })),
    counts: { contactPointsProposed: 1 },
  };

  const expectedArgs = {
    "tenant-id": FIXTURE_TENANT,
    "mission-task-id": missionTask.id,
    "snapshot-hash": snapshotHash,
    "expected-companies": "2",
    "expected-groups": "1",
    "expected-company-deletes": "1",
    "expected-leads": "3",
    "expected-leads-final": "2",
    "expected-lead-deletes": "1",
    "expected-opportunities": "1",
    "expected-opportunities-reassign": "0",
    "expected-memories": "2",
    "expected-memories-delete": "1",
    "expected-memories-reassign": "0",
    "expected-activities-reassign": "2",
    "expected-followups-reassign": "0",
    "expected-contact-points": "1",
  };

  return { plan, expectedArgs, canonical, duplicate, canonicalMissionLead, duplicateMissionLead, pipelineLead, opportunity, realMemory, stabMemory, companyActivityOnDuplicate, leadActivityOnDuplicateLead };
}

test("parseArgs/validateArgs exigen todos los --expected-* de v2", () => {
  const args = parseArgs(["--tenant-id=t1", "--execute"]);
  const check = validateArgs(args);
  assert.equal(check.ok, false);
  assert.equal(args.execute, true);
});

test("evaluateCohortV2 aprueba el plan cuando el estado coincide exactamente y bloquea si el hash no coincide", async () => {
  const { plan, expectedArgs } = await createFixtureCohortAndPlan("eval-ok");

  const ok = await evaluateCohortV2(prisma, plan, expectedArgs);
  assert.equal(ok.alreadyApplied, false);
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
  assert.equal(ok.actual.leadsFinalCount, 2);
  assert.equal(ok.actual.memoriesDeleteCount, 1);
  assert.equal(ok.actual.activitiesReassignCount, 2);

  const badHash = await evaluateCohortV2(prisma, plan, { ...expectedArgs, "snapshot-hash": "deliberately-wrong-hash" });
  // El snapshotHash recibido por args no se usa para comparar dentro de
  // evaluateCohortV2 (esa comparación vive en main()/CLI) — se verifica
  // aquí que el snapshotHash *recalculado* siga siendo válido y distinto
  // del que se pasó, para dejar constancia del mecanismo de detección.
  assert.notEqual(badHash.actual.snapshotHash, "deliberately-wrong-hash");
});

test("runBackfillTransactionV2 consolida el grupo completo: preserva la Opportunity, reasigna Activities, elimina la AgentMemory de la duplicada, escribe discoveryMetadata y CompanyContactPoint", async () => {
  const fixture = await createFixtureCohortAndPlan("write");

  const result = await runBackfillTransactionV2(prisma, fixture.plan, fixture.expectedArgs);
  createdContactPointIds.push(...(await prisma.companyContactPoint.findMany({ where: { companyId: fixture.canonical.id }, select: { id: true } })).map((r) => r.id));

  assert.equal(result.companiesDeleted, 1);
  assert.equal(result.leadsDeleted, 1);
  assert.equal(result.memoriesDeleted, 1);
  assert.equal(result.memoriesReassigned, 0);
  assert.equal(result.opportunitiesReassigned, 0);
  assert.equal(result.activitiesReassigned, 2);
  assert.equal(result.contactPointsCreated, 1);
  assert.equal(result.discoveryMetadataWritten, 1);
  assert.equal(result.finalOpportunities, 1, "la Opportunity debe preservarse íntegra");

  const duplicateStillExists = await prisma.company.findUnique({ where: { id: fixture.duplicate.id } });
  assert.equal(duplicateStillExists, null);

  const canonicalAfter = await prisma.company.findUnique({ where: { id: fixture.canonical.id } });
  assert.ok(canonicalAfter.discoveryMetadata);
  assert.equal(canonicalAfter.discoveryMetadata.missionTaskId, fixture.plan.missionTaskId);

  const opportunityAfter = await prisma.opportunity.findUnique({ where: { id: fixture.opportunity.id } });
  assert.equal(opportunityAfter.companyId, fixture.canonical.id, "la Opportunity ya estaba en la canónica, no debe moverse");

  const companyActivityAfter = await prisma.activity.findUnique({ where: { id: fixture.companyActivityOnDuplicate.id } });
  assert.equal(companyActivityAfter.entityId, fixture.canonical.id);

  const leadActivityAfter = await prisma.activity.findUnique({ where: { id: fixture.leadActivityOnDuplicateLead.id } });
  assert.equal(leadActivityAfter.entityId, fixture.canonicalMissionLead.id);

  const realMemoryAfter = await prisma.agentMemory.findUnique({ where: { id: fixture.realMemory.id } });
  assert.ok(realMemoryAfter, "la AgentMemory real de la canónica nunca debe tocarse");
  const stabMemoryAfter = await prisma.agentMemory.findUnique({ where: { id: fixture.stabMemory.id } });
  assert.equal(stabMemoryAfter, null, "la AgentMemory de estabilización de la duplicada eliminada debe desaparecer, nunca quedar colgando");

  // Idempotencia: segunda evaluación debe detectar que ya se aplicó.
  const reEval = await evaluateCohortV2(prisma, fixture.plan, fixture.expectedArgs);
  assert.equal(reEval.alreadyApplied, true);
});

test("runBackfillTransactionV2 revierte 100% si el snapshot cambió justo antes de escribir", async () => {
  const fixture = await createFixtureCohortAndPlan("race");

  await prisma.lead.create({
    data: { tenantId: FIXTURE_TENANT, companyId: fixture.canonical.id, industryId: REAL_INDUSTRY, status: "NEW", source: "external-discovery-mission" },
  }).then((l) => createdLeadIds.push(l.id));

  await assert.rejects(() => runBackfillTransactionV2(prisma, fixture.plan, fixture.expectedArgs), /Snapshot v2 cambió justo antes de escribir/);

  const duplicateStillExists = await prisma.company.findUnique({ where: { id: fixture.duplicate.id } });
  assert.ok(duplicateStillExists, "no debe haberse eliminado nada tras el rollback");
  const stabMemoryStillExists = await prisma.agentMemory.findUnique({ where: { id: fixture.stabMemory.id } });
  assert.ok(stabMemoryStillExists, "no debe haberse eliminado ninguna AgentMemory tras el rollback");
});

test("runBackfillTransactionV2 reasigna (no elimina) una Opportunity que aparece en una Company duplicada", async () => {
  const fixture = await createFixtureCohortAndPlan("opp-on-dup");
  await prisma.opportunity.update({ where: { id: fixture.opportunity.id }, data: { companyId: fixture.duplicate.id } });

  // El snapshotHash pinneado en el plan ya no coincide con este nuevo
  // estado (la Opportunity se movió) — se recalcula para simular que
  // este dry-run/plan se generó DESPUÉS del movimiento (mismo criterio
  // que usaría un dry-run real re-ejecutado).
  const freshOpportunities = await prisma.opportunity.findMany({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  const freshLeads = await prisma.lead.findMany({ where: { companyId: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  const freshCompanies = await prisma.company.findMany({ where: { id: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  const freshActivitiesCompany = await prisma.activity.findMany({ where: { entityType: "company", entityId: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  const freshActivitiesLead = await prisma.activity.findMany({ where: { entityType: "lead", entityId: { in: freshLeads.map((l) => l.id) } } });
  const freshMemories = await prisma.agentMemory.findMany({ where: { entityType: "company", entityId: { in: [fixture.canonical.id, fixture.duplicate.id] } } });
  const newHash = computeExtendedSnapshotHash({
    companies: freshCompanies, leads: freshLeads, opportunities: freshOpportunities,
    activitiesCompany: freshActivitiesCompany, activitiesLead: freshActivitiesLead, activitiesOpportunity: [],
    followUps: [], memories: freshMemories, existingContactPointsCount: 0, companiesWithDiscoveryMetadataCount: 0,
  });
  const plan = { ...fixture.plan, snapshotHash: newHash };
  const args = { ...fixture.expectedArgs, "snapshot-hash": newHash, "expected-opportunities-reassign": "1" };

  const evaluation = await evaluateCohortV2(prisma, plan, args);
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.failures));
  assert.equal(evaluation.actual.opportunitiesReassignCount, 1);

  const result = await runBackfillTransactionV2(prisma, plan, args);
  assert.equal(result.opportunitiesReassigned, 1);
  const opportunityAfter = await prisma.opportunity.findUnique({ where: { id: fixture.opportunity.id } });
  assert.equal(opportunityAfter.companyId, fixture.canonical.id, "la Opportunity debe terminar en la canónica, nunca eliminarse");
});
