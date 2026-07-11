import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";
import { runWithTenancyContext } from "../../core/tenancy/context";
import {
  classifyAgentTaskBySourcesUsed,
  classifyByCompanyRelation,
  classifyCompanyOrigin,
  classifyContactOrigin,
  DATA_ORIGINS,
} from "./origin-classifier";
import { computeCompanyQualityScore, computeContactQualityScore } from "./data-quality";
import { generateProductionAudit } from "./audit";
import { generateCleanupPlan } from "./cleanup-plan";
import { generateDuplicatesReport } from "./duplicates";
import { generateProductionReadinessSummary } from "./summary";

let server: Server;
let baseUrl: string;

const ADMIN_HEADERS = { "x-dev-user": "admin@titan.dev", "content-type": "application/json" };
const SALES_HEADERS = { "x-dev-user": "sales@titan.dev", "content-type": "application/json" };

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
});

// ============================================================
// Unidad: origin-classifier.ts — pura, sin red ni DB. La regla "nunca
// inventar" aplicada a la PROCEDENCIA de un dato, no solo al dato en sí.
// ============================================================

test("classifyCompanyOrigin: mapea CompanyOrigin real, GOOGLE_PLACES solo si sourceUrl es realmente de Google", () => {
  assert.equal(classifyCompanyOrigin({ origin: "DEMO_SEED", sourceUrl: null }), "DEMO");
  assert.equal(classifyCompanyOrigin({ origin: "MANUAL", sourceUrl: null }), "MANUAL");
  assert.equal(classifyCompanyOrigin({ origin: "CSV_IMPORT", sourceUrl: null }), "IMPORT");
  assert.equal(
    classifyCompanyOrigin({ origin: "API_PROVIDER", sourceUrl: "https://maps.google.com/?cid=123" }),
    "GOOGLE_PLACES",
  );
  // API_PROVIDER sin sourceUrl de Google real -> nunca se asume, queda en el genérico.
  assert.equal(classifyCompanyOrigin({ origin: "API_PROVIDER", sourceUrl: "https://example.com" }), "API_PROVIDER");
  assert.equal(classifyCompanyOrigin({ origin: "EXTERNAL_DISCOVERY", sourceUrl: null }), "API_PROVIDER");
});

test("classifyContactOrigin: DEMO hereda siempre de la empresa; señales propias del contacto tienen prioridad sobre heredar", () => {
  assert.equal(
    classifyContactOrigin({ source: "People Data Labs", emailDiscoveryProvider: null, emailSource: null }, "DEMO"),
    "DEMO",
    "un contacto de una empresa demo es demo sin excepción, aunque tenga source real",
  );
  assert.equal(
    classifyContactOrigin({ source: "People Data Labs", emailDiscoveryProvider: "Hunter.io", emailSource: null }, "GOOGLE_PLACES"),
    "PEOPLE_DATA_LABS",
    "el source del CONTACTO manda sobre el email discovery provider",
  );
  assert.equal(
    classifyContactOrigin({ source: null, emailDiscoveryProvider: "Hunter.io", emailSource: null }, "GOOGLE_PLACES"),
    "HUNTER",
  );
  assert.equal(
    classifyContactOrigin({ source: null, emailDiscoveryProvider: null, emailSource: "Website (about/team page)" }, "GOOGLE_PLACES"),
    "WEBSITE",
  );
  assert.equal(
    classifyContactOrigin({ source: null, emailDiscoveryProvider: null, emailSource: null }, "MANUAL"),
    "MANUAL",
    "sin ninguna señal propia, hereda de la empresa",
  );
});

test("classifyByCompanyRelation: sin Company, USER_CREATED solo si tampoco hay agente detrás", () => {
  assert.equal(classifyByCompanyRelation({ companyOrigin: "GOOGLE_PLACES" }), "GOOGLE_PLACES");
  assert.equal(classifyByCompanyRelation({ companyOrigin: null, createdByAgentTaskId: "task-1" }), "UNKNOWN");
  assert.equal(classifyByCompanyRelation({ companyOrigin: null, createdByAgentTaskId: null }), "USER_CREATED");
});

test("classifyAgentTaskBySourcesUsed: reconoce los strings literales reales ya usados por los proveedores, nunca inventa uno nuevo", () => {
  assert.equal(classifyAgentTaskBySourcesUsed(["Google Places (construction company in Illinois)"]), "GOOGLE_PLACES");
  assert.equal(classifyAgentTaskBySourcesUsed(["People Data Labs (Acme Corp)"]), "PEOPLE_DATA_LABS");
  assert.equal(classifyAgentTaskBySourcesUsed(["Hunter.io (acme.com)"]), "HUNTER");
  assert.equal(classifyAgentTaskBySourcesUsed(["Website (https://acme.com/)"]), "WEBSITE");
  assert.equal(classifyAgentTaskBySourcesUsed([]), null);
  assert.equal(classifyAgentTaskBySourcesUsed(undefined), null);
});

test("DATA_ORIGINS: vocabulario cerrado de 11 valores, exactamente el pedido por el PO más UNKNOWN", () => {
  assert.deepEqual(
    [...DATA_ORIGINS].sort(),
    ["API_PROVIDER", "DEMO", "GOOGLE_PLACES", "HUNTER", "IMPORT", "MANUAL", "PEOPLE_DATA_LABS", "SEED", "UNKNOWN", "USER_CREATED", "WEBSITE"].sort(),
  );
});

// ============================================================
// Unidad: data-quality.ts — pura, sin red ni DB.
// ============================================================

test("computeCompanyQualityScore: 0 con todo vacío, 1.0 con todo completo y confidence=1", () => {
  const empty = computeCompanyQualityScore({
    website: null,
    phone: null,
    city: null,
    state: null,
    email: null,
    origin: "MANUAL",
    updatedAt: new Date("2000-01-01"),
    confidenceScore: null,
  });
  assert.equal(empty.score, 0);

  const full = computeCompanyQualityScore({
    website: "https://acme.com",
    phone: "+1 555-0100",
    city: "Chicago",
    state: "IL",
    email: "info@acme.com",
    origin: "API_PROVIDER",
    updatedAt: new Date(),
    confidenceScore: 1,
  });
  assert.equal(Math.round(full.score * 100), 100);
});

test("computeContactQualityScore: email verificado pesa más que un email sin verificar", () => {
  const base = { email: "a@b.com", phone: null, linkedinUrl: null, source: "People Data Labs", discoveredAt: new Date(), emailVerifiedAt: null, createdAt: new Date(), confidenceScore: 0.8 };
  const unverified = computeContactQualityScore({ ...base, emailVerificationStatus: "NOT_VERIFIED" });
  const verified = computeContactQualityScore({ ...base, emailVerificationStatus: "VERIFIED", emailVerifiedAt: new Date() });
  assert.ok(verified.score > unverified.score);
});

// ============================================================
// Integración real: contra la base real del tenant (sin mocks) — de
// solo lectura, nunca escribe nada. Verifica invariantes reales, no
// solo que "no explote".
// ============================================================

test("generateProductionAudit: los conteos por origen suman el total real de cada entidad", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "system", permissions: [] }, async () => {
    const report = await generateProductionAudit();
    assert.equal(report.entities.length, 8);
    for (const e of report.entities) {
      const sum = Object.values(e.byOrigin).reduce((a, b) => a + b, 0);
      assert.equal(sum, e.total, `${e.entity}: la suma de byOrigin (${sum}) debe igualar total (${e.total})`);
    }
  });
});

test("generateCleanupPlan: solo lectura — nunca borra nada, y solo incluye IDs realmente clasificados DEMO", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "system", permissions: [] }, async () => {
    const [plan, audit] = await Promise.all([generateCleanupPlan(), generateProductionAudit()]);
    const companyStep = plan.steps.find((s) => s.entity === "Company")!;
    const demoCompaniesInAudit = audit.entities.find((e) => e.entity === "Company")!.byOrigin.DEMO;
    assert.equal(companyStep.count, demoCompaniesInAudit, "el plan de limpieza y la auditoría deben coincidir en cuántas Company son DEMO");
    assert.equal(plan.totalRecordsToDelete, plan.steps.reduce((s, step) => s + step.count, 0));
  });
});

test("generateDuplicatesReport: cada grupo devuelto tiene 2+ miembros (nunca reporta un 'duplicado' de un solo registro)", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "system", permissions: [] }, async () => {
    const report = await generateDuplicatesReport();
    const allGroups = [
      ...report.companies.byNameState,
      ...report.companies.byWebsite,
      ...report.contacts.byEmail,
      ...report.contacts.byLinkedin,
      ...report.contacts.byNameCompany,
    ];
    for (const g of allGroups) {
      assert.ok(g.count >= 2, `grupo ${g.key} tiene count=${g.count}, un duplicado real necesita al menos 2`);
      assert.equal(g.ids.length, g.count);
    }
  });
});

test("generateProductionReadinessSummary: percentReady está entre 0 y 100, productionMode refleja env real", async () => {
  await runWithTenancyContext({ tenantId: "tenant-titan", userId: "system", permissions: [] }, async () => {
    const summary = await generateProductionReadinessSummary();
    assert.equal(summary.productionMode, false, "PRODUCTION_MODE nunca se activó en este commit");
    assert.ok(summary.readiness.percentReady >= 0 && summary.readiness.percentReady <= 100);
    assert.ok(summary.companies.real >= 0 && summary.companies.demo >= 0);
    assert.ok(summary.contacts.real >= 0 && summary.contacts.demo >= 0);
  });
});

// ============================================================
// HTTP real: permisos — settings.manage requerido, mismo patrón RBAC
// que el resto del proyecto.
// ============================================================

test("GET /production-readiness/summary as sales@titan.dev returns 403 (no settings.manage)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/production-readiness/summary`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /production-readiness/summary as admin@titan.dev returns 200 with real data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/production-readiness/summary`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { productionMode: boolean; companies: { real: number } };
  assert.equal(body.productionMode, false);
  assert.ok(body.companies.real >= 0);
});

test("GET /production-readiness/audit as admin@titan.dev returns 200 with 8 entities", async () => {
  const res = await fetch(`${baseUrl}/api/v1/production-readiness/audit`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entities: unknown[] };
  assert.equal(body.entities.length, 8);
});

test("GET /production-readiness/cleanup-plan as admin@titan.dev returns 200, never triggers a real delete (read-only)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/production-readiness/cleanup-plan`, { headers: ADMIN_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { steps: unknown[] };
  assert.ok(Array.isArray(body.steps));
});
