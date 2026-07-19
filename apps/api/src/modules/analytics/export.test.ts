// F11.8: GET /analytics/{recruiting,commercial,financial}/export -- CSV
// generado sobre el mismo cálculo real que la versión JSON (nunca una
// query nueva), mismo patrón de descarga que payroll/router.ts (F5.7).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";
import { analyticsRouter } from "./router";
import { exportLimiter } from "../../core/rate-limiters";
import { routeHasMiddleware } from "../../test-helpers/route-wiring";

let server: Server;
let baseUrl: string;

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

const EXPORT_ENDPOINTS = [
  { path: "/analytics/recruiting/export", role: "recruiter", filenamePrefix: "recruiting-metrics-" },
  { path: "/analytics/commercial/export", role: "sales", filenamePrefix: "commercial-metrics-" },
  { path: "/analytics/financial/export", role: "accounting", filenamePrefix: "financial-metrics-" },
];

for (const { path, role, filenamePrefix } of EXPORT_ENDPOINTS) {
  test(`GET ${path} as ${role}@titan.dev returns a real CSV with the expected headers`, async () => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, { headers: { "x-dev-user": `${role}@titan.dev` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /attachment/);
    assert.match(disposition, new RegExp(filenamePrefix));

    const csv = await res.text();
    assert.match(csv, /^"Metric","Value"/);
    assert.ok(csv.split("\n").length > 1);
  });

  test(`GET ${path} as recruiter (may lack the domain permission): never 500, always a valid CSV (even if header-only)`, async () => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, { headers: { "x-dev-user": "recruiter@titan.dev" } });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.match(csv, /^"Metric","Value"/);
  });

  test(`GET ${path} is unreachable from any portal identity`, async () => {
    for (const devUser of ["worker-portal@titan.dev", "candidate-portal@titan.dev", "client-admin@titan.dev"]) {
      const res = await fetch(`${baseUrl}/api/v1${path}`, { headers: { "x-dev-user": devUser } });
      assert.equal(res.status, 403, `${devUser} debería recibir 403`);
    }
  });

  test(`GET ${path} with an invalid query returns 400, not 500`, async () => {
    const res = await fetch(`${baseUrl}/api/v1${path}?from=not-a-date`, { headers: { "x-dev-user": role + "@titan.dev" } });
    assert.equal(res.status, 400);
  });
}

test("recruiting export: includes the funnel rows with real numbers, not placeholder text", async () => {
  const res = await fetch(`${baseUrl}/api/v1/analytics/recruiting/export`, { headers: { "x-dev-user": "recruiter@titan.dev" } });
  const csv = await res.text();
  assert.match(csv, /"Sourced","\d+"/);
  assert.match(csv, /"Qualified","\d+"/);
});

test("financial export: includes marginTrend as a separate Date,Hours,Margin section when there is data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/analytics/financial/export`, { headers: { "x-dev-user": "accounting@titan.dev" } });
  const csv = await res.text();
  if (csv.includes('"Date","Hours","Margin"')) {
    const lines = csv.split("\n");
    const headerIndex = lines.indexOf('"Date","Hours","Margin"');
    assert.ok(headerIndex > 0);
  }
});

// F12.4/F12.11: reescrita en F12.11 para inspeccionar el stack real de
// Express en vez de disparar requests (el limiter se deshabilita bajo
// NODE_ENV=test, ver rate-limiters.ts).
test("F12.4: the three export endpoints have exportLimiter mounted (real, same production router)", () => {
  for (const path of ["/analytics/recruiting/export", "/analytics/commercial/export", "/analytics/financial/export"]) {
    assert.ok(routeHasMiddleware(analyticsRouter, "get", path, exportLimiter), `${path} should have exportLimiter mounted`);
  }
});
