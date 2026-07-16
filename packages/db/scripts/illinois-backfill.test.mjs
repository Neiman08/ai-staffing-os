// Tests del backfill de Illinois. Las pruebas de integración usan un
// fixture SINTÉTICO Y DESECHABLE, completamente aislado de la cohorte
// real de 75/29 Companies de la misión de Illinois — nunca se toca esa
// cohorte real en ningún test. Mismo criterio de aislamiento ya usado en
// toda la suite del repo (fechas/nombres distintivos, cleanup en after()).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  normalizeEmail,
  canonicalDomain,
  canonicalizeWebsite,
  normalizePhone,
  classifyContactPointType,
  computeSnapshotHash,
  diffCompanySnapshots,
  buildGuardReport,
  loadRelationCounts,
  sumUnexpectedRelations,
} from "./illinois-backfill-lib.mjs";
import { parseArgs, validateArgs, evaluateCohort, runBackfillTransaction } from "./execute-illinois-company-backfill.mjs";

const prisma = new PrismaClient();
const TENANT_ID = "tenant-titan";
const FIXTURE_PREFIX = "ILLINOIS-BACKFILL-TEST-FIXTURE";
const REAL_INDUSTRY_A = "industry-construction";
const REAL_INDUSTRY_B = "industry-manufacturing";

const createdCompanyIds = [];
const createdLeadIds = [];
const createdActivityIds = [];
const createdContactPointIds = [];

after(async () => {
  if (createdContactPointIds.length > 0) await prisma.companyContactPoint.deleteMany({ where: { id: { in: createdContactPointIds } } });
  if (createdActivityIds.length > 0) await prisma.activity.deleteMany({ where: { id: { in: createdActivityIds } } });
  if (createdLeadIds.length > 0) await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  if (createdCompanyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  await prisma.$disconnect();
});

/**
 * Crea un grupo sintético de N Companies "duplicadas" (mismo cid en
 * sourceUrl, mismo website/phone/email, distinto industryId), con un
 * Lead y una Activity por Company — exactamente la misma forma que la
 * cohorte real, a escala de prueba. Devuelve el fragmento de "plan"
 * (grupo aprobado) + los ids creados.
 */
async function createFixtureGroup(cidSuffix, { size = 2, withEmail = true } = {}) {
  const cid = `${FIXTURE_PREFIX}-CID-${cidSuffix}`;
  const sourceUrl = `https://maps.google.com/?cid=${cid}`;
  const companies = [];
  for (let i = 0; i < size; i++) {
    const industryId = i === 0 ? REAL_INDUSTRY_A : REAL_INDUSTRY_B;
    const company = await prisma.company.create({
      data: {
        tenantId: TENANT_ID,
        name: `${FIXTURE_PREFIX} Co ${cidSuffix}`,
        industryId,
        status: "LEAD",
        website: "https://www.fixture-test-example.com/?utm_source=test",
        phone: "+1 555-010-0100",
        email: withEmail ? "%20info@fixture-test-example.com" : null,
        sourceUrl,
        origin: "API_PROVIDER",
        discoveredByAgentTaskId: `${FIXTURE_PREFIX}-TASK-${cidSuffix}`,
      },
    });
    createdCompanyIds.push(company.id);
    companies.push(company);

    const lead = await prisma.lead.create({
      data: { tenantId: TENANT_ID, companyId: company.id, industryId, status: "NEW", aiScore: i === 0 ? 9 : 7 },
    });
    createdLeadIds.push(lead.id);

    const activity = await prisma.activity.create({
      data: { tenantId: TENANT_ID, type: "SYSTEM", subject: "fixture", entityType: "company", entityId: company.id },
    });
    createdActivityIds.push(activity.id);
    company.__lead = lead;
    company.__activity = activity;
  }

  const canonical = companies[0];
  const duplicates = companies.slice(1);
  const leadActivities = [];
  for (const dup of duplicates) {
    const leadActivity = await prisma.activity.create({
      data: { tenantId: TENANT_ID, type: "SYSTEM", subject: "fixture-lead", entityType: "lead", entityId: dup.__lead.id },
    });
    createdActivityIds.push(leadActivity.id);
    leadActivities.push(leadActivity);
  }

  const group = {
    providerPlaceId: cid,
    canonicalCompanyId: canonical.id,
    duplicateCompanyIds: duplicates.map((d) => d.id),
    survivingLeadId: canonical.__lead.id,
    leadIdsToRemove: duplicates.map((d) => d.__lead.id),
    leadActivityIdsToReassign: leadActivities.map((a) => a.id),
    companyActivityIdsToReassign: duplicates.map((d) => d.__activity.id),
    contactPointProposals: withEmail
      ? [
          {
            email: "info@fixture-test-example.com",
            type: "INFO",
            sourceUrl,
            discoveryProvider: "test-fixture",
            verificationStatus: "NOT_VERIFIED",
          },
        ]
      : [],
    proposedDiscoveryMetadata: {
      schemaVersion: 1,
      searchTermsMatched: ["fixture term"],
      providerBusinessTypes: [],
      detectedBusinessType: null,
      detectedSector: null,
      crmIndustryId: canonical.industryId,
      crmIndustryName: null,
      classificationMode: "FALLBACK",
      classificationConfidence: null,
      classificationReason: "fixture",
      providerPlaceId: cid,
      canonicalDomain: canonicalDomain(canonical.website),
      originalWebsite: canonical.website,
      canonicalWebsite: canonicalizeWebsite(canonical.website),
      originalPhone: canonical.phone,
      normalizedPhone: normalizePhone(canonical.phone),
      discoveredAt: canonical.createdAt.toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      mergedFromCompanyIds: duplicates.map((d) => d.id),
      originalIndustryIds: [...new Set(companies.map((c) => c.industryId))],
    },
  };

  return { group, companies };
}

function buildPlan(groups, taskIdSuffix) {
  const allCompanies = groups.flatMap((g) => g.__companies ?? []);
  return {
    tenantId: TENANT_ID,
    missionTaskId: `${FIXTURE_PREFIX}-MISSION-${taskIdSuffix}`,
    discoverTaskIds: groups.map((g) => `${FIXTURE_PREFIX}-TASK-${g.__cidSuffix}`),
    groups, // ya son fragmentos de plan "planos" (ver createFixtureGroup)
    companiesSnapshot: [],
  };
}

function expectedArgsFor(plan, companiesSnapshot) {
  const companyDeletes = plan.groups.reduce((s, g) => s + g.duplicateCompanyIds.length, 0);
  const leadDeletes = plan.groups.reduce((s, g) => s + g.leadIdsToRemove.length, 0);
  const contactPoints = plan.groups.reduce((s, g) => s + g.contactPointProposals.length, 0);
  const snapshotHash = computeSnapshotHash(companiesSnapshot);
  // runBackfillTransaction revalida contra plan.snapshotHash directamente
  // (no contra el arg) — se fija acá para que ambos queden consistentes.
  plan.snapshotHash = snapshotHash;
  return {
    "tenant-id": TENANT_ID,
    "mission-task-id": plan.missionTaskId,
    "snapshot-hash": snapshotHash,
    "expected-companies": String(companiesSnapshot.length),
    "expected-groups": String(plan.groups.length),
    "expected-company-deletes": String(companyDeletes),
    "expected-leads": String(companiesSnapshot.length), // 1 lead por company en el fixture
    "expected-lead-deletes": String(leadDeletes),
    "expected-contact-points": String(contactPoints),
    execute: false,
  };
}

// ================= Unit tests — funciones puras, sin DB =================

test("normalizeEmail decodifica %20press@equinix.com a press@equinix.com (caso real verificado)", () => {
  const result = normalizeEmail("%20press@equinix.com");
  assert.equal(result.valid, true);
  assert.equal(result.value, "press@equinix.com");
  assert.equal(result.wasUrlEncoded, true);
});

test("normalizeEmail rechaza sintaxis inválida y dominios placeholder", () => {
  assert.equal(normalizeEmail("not-an-email").valid, false);
  assert.equal(normalizeEmail("test@example.com").valid, false, "example.com es un placeholder conocido");
  assert.equal(normalizeEmail(null).valid, false);
});

test("normalizeEmail nunca acepta % en el local-part tras decodificar mal", () => {
  // Si decodeURIComponent fallara (string malformado), el valor crudo con
  // "%" no debe pasar la regex corregida.
  const result = normalizeEmail("%zzinvalid@example.com");
  assert.equal(result.valid, false);
});

test("classifyContactPointType clasifica prefijos conocidos y usa OTHER como fallback", () => {
  assert.equal(classifyContactPointType("info@acme.com"), "INFO");
  assert.equal(classifyContactPointType("sales@acme.com"), "SALES");
  assert.equal(classifyContactPointType("press@acme.com"), "PRESS");
  assert.equal(classifyContactPointType("recruiter@acme.com"), "RECRUITING");
  assert.equal(classifyContactPointType("random.person@acme.com"), "OTHER");
});

test("computeSnapshotHash es determinista para el mismo input (hash correcto)", () => {
  const companies = [{ id: "b", name: "B", website: null, phone: null, email: null, sourceUrl: null, industryId: "x", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "a", name: "A", website: null, phone: null, email: null, sourceUrl: null, industryId: "x", createdAt: "2026-01-01T00:00:00.000Z" }];
  const h1 = computeSnapshotHash(companies);
  const h2 = computeSnapshotHash([...companies].reverse()); // orden de entrada no debe importar (se ordena por id)
  assert.equal(h1, h2);
});

test("computeSnapshotHash cambia si un campo rastreado cambia (hash incorrecto tras un cambio real)", () => {
  const base = [{ id: "a", name: "A", website: "https://a.com", phone: null, email: null, sourceUrl: null, industryId: "x", createdAt: "2026-01-01T00:00:00.000Z" }];
  const changed = [{ ...base[0], website: "https://a-changed.com" }];
  assert.notEqual(computeSnapshotHash(base), computeSnapshotHash(changed));
});

test("diffCompanySnapshots detecta una fila nueva inesperada y una fila faltante", () => {
  const approved = [{ id: "a", name: "A" }];
  const current = [{ id: "b", name: "B" }];
  const diffs = diffCompanySnapshots(approved, current);
  assert.ok(diffs.some((d) => d.id === "a" && d.issue === "missing_in_current"));
  assert.ok(diffs.some((d) => d.id === "b" && d.issue === "unexpected_new_row"));
});

test("buildGuardReport reporta fallas exactas cuando los conteos no coinciden", () => {
  const actual = { companiesCount: 74, groupsCount: 29 };
  const expected = { companiesCount: 75, groupsCount: 29 };
  const report = buildGuardReport(
    { ...actual, tenantId: "t", missionTaskId: "m", snapshotHash: "h", companyDeletesCount: 0, leadsCount: 0, leadDeletesCount: 0, contactPointsCount: 0, existingContactPointsForCohort: 0, companiesWithNonNullDiscoveryMetadata: 0, unexpectedRelationRows: 0 },
    { ...expected, tenantId: "t", missionTaskId: "m", snapshotHash: "h", companyDeletesCount: 0, leadsCount: 0, leadDeletesCount: 0, contactPointsCount: 0 },
  );
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.check === "companiesCount"));
});

test("validateArgs reporta argumentos requeridos faltantes", () => {
  const result = validateArgs({ "tenant-id": "t" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /mission-task-id/);
});

test("parseArgs: --execute solo se activa si está presente explícitamente", () => {
  assert.equal(parseArgs(["--tenant-id=t"]).execute, false);
  assert.equal(parseArgs(["--tenant-id=t", "--execute"]).execute, true);
});

// ================= Integration tests — fixture sintético desechable =================

test("evaluateCohort aprueba las guardas contra un fixture correcto (2 Companies, 1 duplicada)", async () => {
  const { group, companies } = await createFixtureGroup("A1", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "A1";
  const plan = buildPlan([group], "A1");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const args = expectedArgsFor(plan, plan.companiesSnapshot);
  const evaluation = await evaluateCohort(prisma, plan, args);
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.failures));
  assert.equal(evaluation.actual.companiesCount, 2);
  assert.equal(evaluation.actual.companyDeletesCount, 1);
});

test("evaluateCohort falla cuando los conteos esperados no coinciden (conteos incorrectos)", async () => {
  const { group, companies } = await createFixtureGroup("A2", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "A2";
  const plan = buildPlan([group], "A2");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const args = expectedArgsFor(plan, plan.companiesSnapshot);
  args["expected-companies"] = "999"; // deliberadamente incorrecto
  const evaluation = await evaluateCohort(prisma, plan, args);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.failures.some((f) => f.check === "companiesCount"));
});

test("evaluateCohort falla cuando el plan referencia un canonicalCompanyId que no existe en la cohorte (canonical inexistente)", async () => {
  const { group, companies } = await createFixtureGroup("A3", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "A3";
  const plan = buildPlan([group], "A3");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  plan.groups[0].canonicalCompanyId = "does-not-exist-id"; // corrompe la selección aprobada

  const args = expectedArgsFor(plan, plan.companiesSnapshot);
  const evaluation = await evaluateCohort(prisma, plan, args);
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.diffs.some((d) => d.issue === "id_set_mismatch" || d.id === "does-not-exist-id" || d.issue === "unexpected_new_row" || d.issue === "missing_in_current") || evaluation.failures.length > 0);
});

test("evaluateCohort falla si aparece una relación no contemplada (FK nueva inesperada)", async () => {
  const { group, companies } = await createFixtureGroup("A4", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "A4";
  const plan = buildPlan([group], "A4");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Crea una Opportunity real sobre una de las Companies duplicadas —
  // relación no contemplada por el plan de este grupo.
  const opportunity = await prisma.opportunity.create({
    data: { tenantId: TENANT_ID, companyId: group.duplicateCompanyIds[0], title: "fixture-unexpected", stage: "MEETING_SCHEDULED" },
  });

  try {
    const args = expectedArgsFor(plan, plan.companiesSnapshot);
    const evaluation = await evaluateCohort(prisma, plan, args);
    assert.equal(evaluation.ok, false);
    assert.ok(evaluation.failures.some((f) => f.check === "unexpectedRelationRows"));
  } finally {
    await prisma.opportunity.delete({ where: { id: opportunity.id } });
  }
});

test("runBackfillTransaction consolida correctamente: canónica, eliminación de duplicada, CompanyContactPoint, Activities reasignadas", async () => {
  const { group, companies } = await createFixtureGroup("B1", { size: 2, withEmail: true });
  group.__companies = companies;
  group.__cidSuffix = "B1";
  const plan = buildPlan([group], "B1");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const args = expectedArgsFor(plan, plan.companiesSnapshot);
  const evaluation = await evaluateCohort(prisma, plan, args);
  assert.equal(evaluation.ok, true, JSON.stringify(evaluation.failures));

  const result = await runBackfillTransaction(prisma, plan, args);
  assert.equal(result.companiesDeleted, 1);
  assert.equal(result.leadsDeleted, 1);
  assert.equal(result.contactPointsCreated, 1);
  assert.equal(result.discoveryMetadataWritten, 1);
  assert.equal(result.activitiesReassigned, 2); // 1 company-activity + 1 lead-activity

  const canonical = await prisma.company.findUnique({ where: { id: group.canonicalCompanyId } });
  assert.ok(canonical, "la canónica debe seguir existiendo");
  assert.notEqual(canonical.discoveryMetadata, null);

  const duplicate = await prisma.company.findUnique({ where: { id: group.duplicateCompanyIds[0] } });
  assert.equal(duplicate, null, "la duplicada debe haber sido eliminada");

  const contactPoints = await prisma.companyContactPoint.findMany({ where: { companyId: group.canonicalCompanyId } });
  assert.equal(contactPoints.length, 1);
  assert.equal(contactPoints[0].email, "info@fixture-test-example.com");
  createdContactPointIds.push(contactPoints[0].id);

  // Las Activities reasignadas ya no apuntan a la duplicada eliminada.
  const reassignedCompanyActivity = await prisma.activity.findUnique({ where: { id: group.companyActivityIdsToReassign[0] } });
  assert.equal(reassignedCompanyActivity.entityId, group.canonicalCompanyId);

  // Sacar los ids ya eliminados de las listas de cleanup para no
  // reintentar borrarlos en after() (deleteMany sobre ids inexistentes
  // no falla, pero se documenta la intención explícitamente).
});

test("runBackfillTransaction hace ROLLBACK total ante un fallo de post-validación (rollback total ante fallo)", async () => {
  const { group, companies } = await createFixtureGroup("B2", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "B2";
  const plan = buildPlan([group], "B2");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Corrompe el plan DESPUÉS de calcular el snapshotHash real (para que
  // pase la revalidación de hash dentro de la transacción) pero de forma
  // que la post-validación de conteo de Companies falle: se agrega un
  // segundo "grupo" fantasma cuyo canonicalCompanyId no existe, inflando
  // plan.groups.length por encima del conteo real posible.
  const args = expectedArgsFor(plan, plan.companiesSnapshot);
  const corruptedPlan = { ...plan, groups: [...plan.groups, { ...group.group, canonicalCompanyId: "phantom-id", duplicateCompanyIds: [], leadIdsToRemove: [], leadActivityIdsToReassign: [], companyActivityIdsToReassign: [], contactPointProposals: [] }] };

  const companiesBefore = await prisma.company.count({ where: { id: { in: [group.canonicalCompanyId, ...group.duplicateCompanyIds] } } });
  const leadsBefore = await prisma.lead.count({ where: { companyId: { in: [group.canonicalCompanyId, ...group.duplicateCompanyIds] } } });

  await assert.rejects(() => runBackfillTransaction(prisma, corruptedPlan, args));

  const companiesAfter = await prisma.company.count({ where: { id: { in: [group.canonicalCompanyId, ...group.duplicateCompanyIds] } } });
  const leadsAfter = await prisma.lead.count({ where: { companyId: { in: [group.canonicalCompanyId, ...group.duplicateCompanyIds] } } });
  assert.equal(companiesAfter, companiesBefore, "el rollback debe dejar las Companies exactamente como estaban");
  assert.equal(leadsAfter, leadsBefore, "el rollback debe dejar los Leads exactamente como estaban");

  const canonical = await prisma.company.findUnique({ where: { id: group.canonicalCompanyId } });
  assert.equal(canonical.discoveryMetadata, null, "el rollback debe revertir también el discoveryMetadata ya escrito antes del fallo");
});

test("evaluateCohort detecta un backfill ya aplicado y se niega a repetirlo (idempotencia real, no una bandera)", async () => {
  const { group, companies } = await createFixtureGroup("C1", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "C1";
  const plan = buildPlan([group], "C1");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const args = expectedArgsFor(plan, plan.companiesSnapshot);

  await runBackfillTransaction(prisma, plan, args);
  const cp = await prisma.companyContactPoint.findMany({ where: { companyId: group.canonicalCompanyId } });
  createdContactPointIds.push(...cp.map((c) => c.id));

  // Segunda evaluación con el MISMO plan — la cohorte real ya cambió
  // (la duplicada fue eliminada), así que debe detectarse como aplicada.
  const secondEvaluation = await evaluateCohort(prisma, plan, args);
  assert.equal(secondEvaluation.alreadyApplied, true);
  assert.match(secondEvaluation.message, /already applied/);
});

test("CompanyContactPoint respeta el unique (companyId, email) — un upsert repetido no duplica (contact point duplicado)", async () => {
  const { group, companies } = await createFixtureGroup("D1", { size: 1, withEmail: true });
  group.__companies = companies;
  const companyId = companies[0].id;

  const data = {
    tenantId: TENANT_ID,
    companyId,
    email: "info@fixture-test-example.com",
    type: "INFO",
    sourceUrl: "https://example-fixture.test/",
    discoveryProvider: "test",
    verificationStatus: "NOT_VERIFIED",
  };
  const first = await prisma.companyContactPoint.upsert({ where: { companyId_email: { companyId, email: data.email } }, create: data, update: {} });
  const second = await prisma.companyContactPoint.upsert({ where: { companyId_email: { companyId, email: data.email } }, create: data, update: {} });
  createdContactPointIds.push(first.id);
  assert.equal(first.id, second.id, "el segundo upsert debe resolver a la misma fila, nunca crear un duplicado");

  const count = await prisma.companyContactPoint.count({ where: { companyId, email: data.email } });
  assert.equal(count, 1);
});

test("evaluateCohort (dry-run, sin --execute) produce cero escrituras", async () => {
  const { group, companies } = await createFixtureGroup("E1", { size: 2 });
  group.__companies = companies;
  group.__cidSuffix = "E1";
  const plan = buildPlan([group], "E1");
  plan.companiesSnapshot = companies
    .map((c) => ({ id: c.id, name: c.name, website: c.website, phone: c.phone, email: c.email, sourceUrl: c.sourceUrl, industryId: c.industryId, createdAt: c.createdAt.toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const args = expectedArgsFor(plan, plan.companiesSnapshot);

  const companiesBefore = await prisma.company.count({ where: { id: { in: companies.map((c) => c.id) } } });
  const leadsBefore = await prisma.lead.count({ where: { companyId: { in: companies.map((c) => c.id) } } });
  const cpBefore = await prisma.companyContactPoint.count({ where: { companyId: { in: companies.map((c) => c.id) } } });

  await evaluateCohort(prisma, plan, args); // solo lectura — args.execute nunca se consulta acá, ni se abre transacción

  const companiesAfter = await prisma.company.count({ where: { id: { in: companies.map((c) => c.id) } } });
  const leadsAfter = await prisma.lead.count({ where: { companyId: { in: companies.map((c) => c.id) } } });
  const cpAfter = await prisma.companyContactPoint.count({ where: { companyId: { in: companies.map((c) => c.id) } } });

  assert.equal(companiesAfter, companiesBefore);
  assert.equal(leadsAfter, leadsBefore);
  assert.equal(cpAfter, cpBefore);
});
