import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { prisma } from "@ai-staffing-os/db";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;
const createdLeadIds: string[] = [];
const createdCandidateIds: string[] = [];

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
  await prisma.activity.deleteMany({ where: { entityId: { in: [...createdLeadIds, ...createdCandidateIds] } } });
  await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  await prisma.candidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ============================================================
// F4.8: rutas públicas — SIN ningún header de auth (x-dev-user), nunca.
// Es la propiedad de seguridad más importante de este módulo: un
// visitante anónimo real de dreistaff.com no tiene sesión ni la va a
// tener nunca en este flujo.
// ============================================================

test("GET /public/branding: responde sin ningún header de auth, con la marca real", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/branding`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { brandName: string; domain: string };
  assert.equal(body.brandName, "DreiStaff");
  assert.equal(body.domain, "dreistaff.com");
});

test("GET /public/industries: sin auth, devuelve industrias reales del tenant (nunca inventadas)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/industries`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ name: string }>;
  assert.ok(body.length > 0);
  const realNames = new Set((await prisma.industry.findMany({ select: { name: true } })).map((i) => i.name));
  for (const industry of body) assert.ok(realNames.has(industry.name), `${industry.name} debe ser una industria real del CRM`);
});

test("GET /public/job-openings: sin auth, nunca incluye una empresa demo ni el nombre de la empresa cliente", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/job-openings`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  for (const opening of body) {
    assert.ok(!("companyName" in opening), "nunca debe exponerse el nombre de la empresa cliente");
    assert.ok(!("billRate" in opening) && !("payRate" in opening), "nunca deben exponerse tarifas internas");
  }
});

test("GET /public/stats: sin auth, companiesInNetwork nunca cuenta empresas demo", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/stats`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { companiesInNetwork: number };
  // F14: el endpoint real (core/public-tenant.ts) siempre escopa por
  // PUBLIC_TENANT_SLUG -- contar sin ese mismo filtro de tenant hacía
  // que este assert dependiera de que NINGÚN otro tenant de la base
  // compartida de desarrollo tuviera Company reales (frágil: cualquier
  // otro test, o una validación manual como la de F14, agrega
  // companies a OTRO tenant y este conteo global diverge del que el
  // endpoint realmente devuelve).
  const publicTenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: process.env.PUBLIC_TENANT_SLUG ?? "titan" } });
  const realCompanyCount = await prisma.company.count({ where: { tenantId: publicTenant.id, origin: { not: "DEMO_SEED" } } });
  assert.equal(body.companiesInNetwork, realCompanyCount);
});

test("POST /public/contact: crea un Lead real, sin auth, nunca envía un email", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactName: "Test Suite Contact", email: "test-suite-contact@example.com", message: "automated test" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { leadId: string };
  createdLeadIds.push(body.leadId);

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: body.leadId } });
  assert.equal(lead.source, "website-contact-form");
  assert.equal(lead.status, "NEW");
});

test("POST /public/request-talent: crea un Lead real con industria resuelta contra el CRM real", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/request-talent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      companyName: "Test Suite Manufacturing",
      contactName: "Test Suite Requester",
      email: "test-suite-request@example.com",
      industryName: "Manufacturing",
      state: "IL",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { leadId: string };
  createdLeadIds.push(body.leadId);

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: body.leadId } });
  assert.equal(lead.source, "website-request-talent");
  assert.equal(lead.industryId, "industry-manufacturing");
});

test("POST /public/request-talent: una industria que no existe en el CRM nunca se inventa — queda sin industryId", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/request-talent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contactName: "Test Suite Fake Industry",
      email: "test-suite-fake-industry@example.com",
      industryName: "Underwater Basket Weaving",
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { leadId: string };
  createdLeadIds.push(body.leadId);
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: body.leadId } });
  assert.equal(lead.industryId, null);
});

test("POST /public/apply: crea un Candidate real, sin auth", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Suite", email: "test-suite-apply@example.com", smsOptIn: false }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { candidateId: string };
  createdCandidateIds.push(body.candidateId);

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: body.candidateId } });
  assert.equal(candidate.source, "website-careers");
  assert.equal(candidate.status, "NEW");
});

test("POST /public/apply: email inválido rechazado con 400 (nunca crea un Candidate con datos basura)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/public/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Bad", lastName: "Email", email: "not-an-email" }),
  });
  assert.equal(res.status, 400);
});
