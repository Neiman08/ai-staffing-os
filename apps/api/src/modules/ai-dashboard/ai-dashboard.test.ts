import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

/**
 * Bug real encontrado en auditoría de "primera misión real": a
 * diferencia de crm/service.ts, campaign-tools.impl.ts y public/service.ts,
 * getAiDashboardSummary() nunca excluía Company.origin=DEMO_SEED/
 * INTERNAL_TEST -- un operador real vería sus métricas infladas o
 * distorsionadas por datos de demo/prueba interna.
 */

let server: Server;
let baseUrl: string;
const ADMIN_HEADERS = { "x-dev-user": "admin@titan.dev", "content-type": "application/json" };

const createdCompanyIds: string[] = [];

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
});

test("GET /ai-dashboard/summary nunca cuenta Company de origin=DEMO_SEED/INTERNAL_TEST en newCompaniesToday/companiesByIndustry/companiesByState", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const real = await prisma.company.create({
    data: { tenantId: "tenant-titan", name: `AI Dashboard Real ${suffix}`, industryId: "industry-manufacturing", state: "IL", origin: "MANUAL" },
  });
  const demo = await prisma.company.create({
    data: { tenantId: "tenant-titan", name: `AI Dashboard Demo ${suffix}`, industryId: "industry-manufacturing", state: "IL", origin: "DEMO_SEED" },
  });
  const internalTest = await prisma.company.create({
    data: { tenantId: "tenant-titan", name: `AI Dashboard InternalTest ${suffix}`, industryId: "industry-manufacturing", state: "IL", origin: "INTERNAL_TEST" },
  });
  createdCompanyIds.push(real.id, demo.id, internalTest.id);

  const res = await fetch(`${baseUrl}/api/v1/ai-dashboard/summary`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    newCompaniesToday: number;
    companiesByIndustry: Array<{ industryName: string; count: number }>;
    companiesByState: Array<{ state: string; count: number }>;
  };

  const realCount = await prisma.company.count({ where: { tenantId: "tenant-titan", createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }, origin: { notIn: ["DEMO_SEED", "INTERNAL_TEST"] } } });
  assert.equal(body.newCompaniesToday, realCount, "newCompaniesToday debe coincidir exactamente con el conteo real (sin demo/test), nunca inflado por las 2 fixtures de demo/test recién creadas");

  const manufacturing = body.companiesByIndustry.find((i) => i.industryName === "Manufacturing");
  const manufacturingRealCount = await prisma.company.count({ where: { tenantId: "tenant-titan", industryId: "industry-manufacturing", origin: { notIn: ["DEMO_SEED", "INTERNAL_TEST"] } } });
  assert.ok(manufacturing, "Manufacturing debe seguir apareciendo (tiene empresas reales)");
  assert.equal(manufacturing!.count, manufacturingRealCount, "el desglose por industria nunca debe incluir las empresas DEMO_SEED/INTERNAL_TEST recién creadas");
});
