import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@ai-staffing-os/db";
import { runWithTenancyContext } from "../../core/tenancy/context";
import { getFreshHunterDomainCache, recordHunterDomainQuery } from "./hunter-domain-cache";
import type { EmailCandidate } from "./tools/email-providers/types";

/**
 * F27 Fase 7: Hunter.io corre en el free tier (25 búsquedas/mes TOTAL) --
 * esta caché evita repetir una consulta real por el mismo dominio dentro
 * de la ventana de frescura. Nunca llama a Hunter real -- pruebas
 * puramente de la caché en la base real.
 */

const TEST_PREFIX = "F27-HUNTER-CACHE-TEST";
const createdTenantIds: string[] = [];

async function setupTenant(suffix: string): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: { name: `${TEST_PREFIX}-${suffix}`, slug: `${TEST_PREFIX.toLowerCase()}-${suffix}-${Date.now()}` },
  });
  createdTenantIds.push(tenant.id);
  return tenant.id;
}

after(async () => {
  if (createdTenantIds.length) {
    await prisma.hunterDomainSearchCache.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  }
});

const SAMPLE_CANDIDATES: EmailCandidate[] = [
  { firstName: "Jane", lastName: "Doe", title: "HR Manager", email: "jane.doe@example.com", confidenceScore: 0.9, sourceUrl: null },
];

test("getFreshHunterDomainCache: sin ninguna consulta previa, devuelve null -- nunca inventa un resultado", async () => {
  const tenantId = await setupTenant("no-cache-yet");
  const hit = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getFreshHunterDomainCache("never-queried.example"));
  assert.equal(hit, null);
});

test("recordHunterDomainQuery + getFreshHunterDomainCache: un cache hit reconstruye exactamente los candidatos reales de la última consulta", async () => {
  const tenantId = await setupTenant("hit");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    recordHunterDomainQuery(tenantId, "acme.example", SAMPLE_CANDIDATES, [], "AVAILABLE"),
  );

  const hit = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getFreshHunterDomainCache("acme.example"));

  assert.ok(hit);
  assert.deepEqual(hit!.candidates, SAMPLE_CANDIDATES);
  assert.equal(hit!.providerStatus, "AVAILABLE");
});

test("recordHunterDomainQuery: una segunda consulta real para el MISMO dominio actualiza la misma fila, nunca crea una segunda", async () => {
  const tenantId = await setupTenant("refresh-same-row");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => recordHunterDomainQuery(tenantId, "refresh.example", [], [], "AVAILABLE"));
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () =>
    recordHunterDomainQuery(tenantId, "refresh.example", SAMPLE_CANDIDATES, [], "AVAILABLE"),
  );

  const rows = await prisma.hunterDomainSearchCache.findMany({ where: { tenantId, domain: "refresh.example" } });
  assert.equal(rows.length, 1, "el mismo dominio nunca debe generar una segunda fila");
  assert.deepEqual(rows[0]!.candidates, SAMPLE_CANDIDATES);
});

test("getFreshHunterDomainCache: una fila vieja (fuera de la ventana de frescura) nunca se usa -- se trata como si no hubiera caché", async () => {
  const tenantId = await setupTenant("stale");
  await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => recordHunterDomainQuery(tenantId, "stale.example", SAMPLE_CANDIDATES, [], "AVAILABLE"));

  // Simula que la fila real se escribió hace 31 días (fuera de la ventana de 30 días).
  await prisma.hunterDomainSearchCache.updateMany({
    where: { tenantId, domain: "stale.example" },
    data: { queriedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
  });

  const hit = await runWithTenancyContext({ tenantId, userId: "test-user", permissions: [] }, () => getFreshHunterDomainCache("stale.example"));
  assert.equal(hit, null);
});

test("getFreshHunterDomainCache: nunca mezcla la caché de OTRO tenant, aunque el dominio sea idéntico", async () => {
  const tenantA = await setupTenant("isolation-a");
  const tenantB = await setupTenant("isolation-b");
  await runWithTenancyContext({ tenantId: tenantB, userId: "test-user", permissions: [] }, () =>
    recordHunterDomainQuery(tenantB, "shared-domain.example", SAMPLE_CANDIDATES, [], "AVAILABLE"),
  );

  const hitFromA = await runWithTenancyContext({ tenantId: tenantA, userId: "test-user", permissions: [] }, () => getFreshHunterDomainCache("shared-domain.example"));
  assert.equal(hitFromA, null, "la caché de otro tenant nunca debe ser visible");
});
