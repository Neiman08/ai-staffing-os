import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { createOrMergeHumanReviewRequest, listHumanReviewRequests, resolveHumanReviewRequest, getHumanReviewRequest } from "./service";

/**
 * F25.2 Fase 5: pruebas de integración contra Postgres real (local) del
 * Human Review Center -- dedup real (índice único parcial), fusión de
 * evidencia, resolución, y que un caso resuelto pueda volver a abrirse
 * más tarde sin chocar contra el constraint de dedup.
 */

const TEST_PREFIX = "F25-2-HUMAN-REVIEW";
const createdTenantIds: string[] = [];

after(async () => {
  if (createdTenantIds.length) {
    await prisma.humanReviewRequest.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenancyContext({ tenantId, userId: "test-reviewer", permissions: [] }, fn);
}

function baseInput(overrides: Partial<Parameters<typeof createOrMergeHumanReviewRequest>[0]> = {}) {
  return {
    type: "CONTACT_AMBIGUOUS" as const,
    priority: "HIGH" as const,
    entityType: "company",
    entityId: "company_hr_test",
    summary: "Dos contactos con el mismo email en dominios distintos",
    evidence: [{ source: "contact-intelligence", detail: "email duplicado" }],
    requestedDecision: "Elegir el contacto correcto",
    options: [{ label: "Usar contacto A", consequence: "Se descarta B" }],
    impact: "El outreach queda bloqueado hasta decidir",
    correlationId: "mission_hr_test",
    ...overrides,
  };
}

test("createOrMergeHumanReviewRequest crea un caso nuevo cuando no hay uno abierto", async () => {
  const tenantId = await setupTenant("create");
  const { request, merged } = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));

  assert.equal(merged, false);
  assert.equal(request.tenantId, tenantId);
  assert.equal(request.type, "CONTACT_AMBIGUOUS");
  assert.equal(request.resolvedAt, null);
  assert.deepEqual(request.evidence, [{ source: "contact-intelligence", detail: "email duplicado" }]);
});

test("createOrMergeHumanReviewRequest fusiona evidencia en el caso abierto existente (dedup real, no convención)", async () => {
  const tenantId = await setupTenant("dedup");
  const first = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));
  const second = await withTenant(tenantId, () =>
    createOrMergeHumanReviewRequest(baseInput({ evidence: [{ source: "quality-agent", detail: "segunda señal" }] })),
  );

  assert.equal(second.merged, true);
  assert.equal(second.request.id, first.request.id, "nunca crea una segunda fila para el mismo (entityType, entityId, type) abierto");

  const rows = await prisma.humanReviewRequest.findMany({ where: { tenantId } });
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.evidence as unknown[]).length, 2, "la evidencia se acumula, no se reemplaza");
});

test("un caso resuelto puede volver a abrirse más tarde sin chocar contra el dedup", async () => {
  const tenantId = await setupTenant("reopen");
  const first = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));
  await withTenant(tenantId, () => resolveHumanReviewRequest(first.request.id, "user-1", "Se eligió el contacto A"));

  const second = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));

  assert.equal(second.merged, false, "un caso RESUELTO no cuenta como abierto -- esto es un caso nuevo, no una fusión");
  assert.notEqual(second.request.id, first.request.id);

  const rows = await prisma.humanReviewRequest.findMany({ where: { tenantId } });
  assert.equal(rows.length, 2);
});

test("resolveHumanReviewRequest setea resolvedAt/resolvedById/resolution; resolver dos veces falla", async () => {
  const tenantId = await setupTenant("resolve");
  const { request } = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));

  const resolved = await withTenant(tenantId, () => resolveHumanReviewRequest(request.id, "user-42", "Decisión: usar el dominio oficial"));
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.resolvedById, "user-42");
  assert.equal(resolved.resolution, "Decisión: usar el dominio oficial");

  await assert.rejects(() => withTenant(tenantId, () => resolveHumanReviewRequest(request.id, "user-99", "otra vez")), /ya está resuelto/);
});

test("listHumanReviewRequests filtra por status y ordena por prioridad (URGENT primero)", async () => {
  const tenantId = await setupTenant("list");
  const low = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput({ priority: "LOW", entityId: "c1", type: "CONTENT_RISK" })));
  const urgent = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput({ priority: "URGENT", entityId: "c2", type: "CONTENT_RISK" })));
  await withTenant(tenantId, () => resolveHumanReviewRequest(low.request.id, "user-1", "resuelto"));

  const open = await withTenant(tenantId, () => listHumanReviewRequests({ status: "OPEN" }));
  assert.equal(open.length, 1);
  assert.equal(open[0]!.id, urgent.request.id);

  const resolved = await withTenant(tenantId, () => listHumanReviewRequests({ status: "RESOLVED" }));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.id, low.request.id);

  const both = await withTenant(tenantId, () =>
    createOrMergeHumanReviewRequest(baseInput({ priority: "MEDIUM", entityId: "c3", type: "CONTENT_RISK" })),
  );
  const allOpenOrdered = await withTenant(tenantId, () => listHumanReviewRequests({ status: "OPEN" }));
  assert.deepEqual(
    allOpenOrdered.map((r) => r.id),
    [urgent.request.id, both.request.id],
    "URGENT antes que MEDIUM",
  );
});

test("getHumanReviewRequest devuelve el registro por id", async () => {
  const tenantId = await setupTenant("get");
  const { request } = await withTenant(tenantId, () => createOrMergeHumanReviewRequest(baseInput()));
  const fetched = await withTenant(tenantId, () => getHumanReviewRequest(request.id));
  assert.equal(fetched.id, request.id);
});
