// F11.4: GET /analytics/recruiting -- funnel (sourced/qualified/
// shortlisted/placed), time-to-fill, efectividad por fuente. Field-level
// por permiso real (candidates.view para el funnel/fuente,
// jobOrders.view además para time-to-fill), mismo criterio F6.8.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

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

interface RecruitingBody {
  generatedAt: string;
  recruiting: {
    period?: { from: string; to: string };
    funnel?: { sourced: number; qualified: number; shortlisted: number; placed: number };
    timeToFill?: { averageDays: number | null; jobOrdersFilled: number };
    sourceEffectiveness?: Array<{ source: string; candidateCount: number; placedCount: number; placementRate: number }>;
  };
}

async function fetchRecruiting(devUser: string, qs = ""): Promise<{ status: number; body: RecruitingBody }> {
  const res = await fetch(`${baseUrl}/api/v1/analytics/recruiting${qs}`, { headers: { "x-dev-user": devUser } });
  const body = (await res.json()) as RecruitingBody;
  return { status: res.status, body };
}

test("recruiter@titan.dev (candidates.view + jobOrders.view): ve funnel, timeToFill y sourceEffectiveness completos", async () => {
  const { status, body } = await fetchRecruiting("recruiter@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.recruiting.funnel);
  assert.ok(body.recruiting.timeToFill !== undefined);
  assert.ok(body.recruiting.sourceEffectiveness);
  assert.ok(body.recruiting.period);

  assert.ok(body.recruiting.funnel!.sourced >= 0);
  assert.ok(body.recruiting.funnel!.qualified >= 0);
  assert.ok(body.recruiting.funnel!.shortlisted >= 0);
  assert.ok(body.recruiting.funnel!.placed >= 0);
});

test("sales@titan.dev (sin candidates.view): recruiting queda vacío, nunca 403", async () => {
  const { status, body } = await fetchRecruiting("sales@titan.dev");
  assert.equal(status, 200);
  assert.deepEqual(body.recruiting, {});
});

test("payroll@titan.dev (candidates.view=false por rol -- verificar contra seed): comportamiento coherente con permisos", async () => {
  // Payroll no tiene candidates.view (ver ROLE_PERMISSIONS en seed.ts) -> recruiting vacío.
  const { status, body } = await fetchRecruiting("payroll@titan.dev");
  assert.equal(status, 200);
  assert.deepEqual(body.recruiting, {});
});

test("marketing@titan.dev (candidates.view sin jobOrders.view): funnel/sourceEffectiveness presentes, timeToFill ausente", async () => {
  const { status, body } = await fetchRecruiting("marketing@titan.dev");
  assert.equal(status, 200);
  assert.ok(body.recruiting.funnel);
  assert.ok(body.recruiting.sourceEffectiveness);
  assert.equal(body.recruiting.timeToFill, undefined);
});

test("filtro from/to real: un rango sin ningún candidato real devuelve un funnel en cero, no un error", async () => {
  const { status, body } = await fetchRecruiting("recruiter@titan.dev", "?from=2010-01-01&to=2010-01-02");
  assert.equal(status, 200);
  assert.deepEqual(body.recruiting.funnel, { sourced: 0, qualified: 0, shortlisted: 0, placed: 0 });
  assert.equal(body.recruiting.timeToFill!.averageDays, null);
  assert.equal(body.recruiting.timeToFill!.jobOrdersFilled, 0);
});

test("sourceEffectiveness: cada entrada tiene un placementRate coherente (placedCount <= candidateCount)", async () => {
  const { body } = await fetchRecruiting("recruiter@titan.dev");
  for (const entry of body.recruiting.sourceEffectiveness ?? []) {
    assert.ok(entry.placedCount <= entry.candidateCount);
    assert.ok(entry.placementRate >= 0 && entry.placementRate <= 100);
  }
});

test("ninguna identidad de portal puede alcanzar /analytics/recruiting", async () => {
  for (const devUser of ["worker-portal@titan.dev", "candidate-portal@titan.dev", "client-admin@titan.dev"]) {
    const { status } = await fetchRecruiting(devUser);
    assert.equal(status, 403, `${devUser} debería recibir 403`);
  }
});

test("query inválida (from no-fecha) devuelve 400, no 500", async () => {
  const res = await fetch(`${baseUrl}/api/v1/analytics/recruiting?from=not-a-date`, {
    headers: { "x-dev-user": "recruiter@titan.dev" },
  });
  assert.equal(res.status, 400);
});
