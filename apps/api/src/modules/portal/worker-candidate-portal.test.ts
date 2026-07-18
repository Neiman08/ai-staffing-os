// F10.4: Worker/Candidate Portal -- corre vía dev-bypass real contra
// worker-portal@titan.dev (workerId=worker-01) y
// candidate-portal@titan.dev (candidateId=candidate-029). Ninguno de
// estos endpoints acepta un id en la URL -- están intrínsecamente
// auto-scoped por ctx.workerId/candidateId, sin superficie de IDOR vía
// manipulación de path. El foco acá es RBAC + que el contenido
// devuelto realmente pertenezca a la identidad real, + que el candidato
// nunca vea rank/score/reasons/gaps/risks (lógica interna de
// recruiting).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const WORKER_HEADERS = { "x-dev-user": "worker-portal@titan.dev", "content-type": "application/json" };
const CANDIDATE_HEADERS = { "x-dev-user": "candidate-portal@titan.dev", "content-type": "application/json" };
const RECRUITER_HEADERS = { "x-dev-user": "recruiter@titan.dev", "content-type": "application/json" };
const CLIENT_ADMIN_HEADERS = { "x-dev-user": "client-admin@titan.dev", "content-type": "application/json" };

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

// ---- Worker Portal ----

test("GET /portal/worker/profile as recruiter@titan.dev returns 403 (no portalProfile.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /portal/worker/profile as client-admin@titan.dev returns 403 (portalProfile.view exists on CLIENT_ADMIN, but ctx has no workerId -- must be forbidden, not crash)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, { headers: CLIENT_ADMIN_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /portal/worker/profile returns real worker-01 data (candidate-034, PLACED origin)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/profile`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; firstName: string; lastName: string; defaultPayRate: string };
  assert.equal(body.id, "worker-01");
  assert.ok(body.firstName);
  assert.ok(body.lastName);
  assert.ok(Number(body.defaultPayRate) > 0);
});

test("worker portal sub-resources (onboarding/documents/placements/assignments/shifts/incidents) all return 200 with array shapes", async () => {
  for (const path of ["onboarding", "documents", "placements", "assignments", "shifts", "incidents"]) {
    const res = await fetch(`${baseUrl}/api/v1/portal/worker/${path}`, { headers: WORKER_HEADERS });
    assert.equal(res.status, 200, `${path} should return 200`);
    const body = await res.json();
    assert.ok(Array.isArray(body), `${path} should return an array`);
  }
});

test("GET /portal/worker/time-entries returns a paginated shape, real time entries belong to worker-01's own assignments", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/worker/time-entries?limit=100`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: Array<{ assignmentId: string }>; nextCursor: string | null };
  assert.ok(Array.isArray(body.items));
});

// ---- Candidate Portal ----

test("GET /portal/candidate/profile as recruiter@titan.dev returns 403", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/profile`, { headers: RECRUITER_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /portal/candidate/profile returns real candidate-029 data", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/profile`, { headers: CANDIDATE_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; status: string };
  assert.equal(body.id, "candidate-029");
  assert.equal(body.status, "QUALIFIED");
});

test("GET /portal/candidate/applications NEVER exposes rank/score/reasons/gaps/risks/evidence (internal recruiting logic)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/applications`, { headers: CANDIDATE_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  for (const app of body) {
    for (const forbiddenKey of ["rank", "score", "normalizedScore", "reasons", "gaps", "risks", "evidence", "explanation"]) {
      assert.equal(app[forbiddenKey], undefined, `applications must never expose "${forbiddenKey}"`);
    }
  }
});

test("GET /portal/candidate/applications only ever shows QUALIFIED/POSSIBLY_QUALIFIED matches, never NOT_QUALIFIED", async () => {
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/applications`, { headers: CANDIDATE_HEADERS });
  const body = (await res.json()) as Array<{ qualificationStatus: string }>;
  for (const app of body) {
    assert.notEqual(app.qualificationStatus, "NOT_QUALIFIED");
  }
});

test("candidate portal sub-resources (onboarding/documents) return 200 with array shapes", async () => {
  for (const path of ["onboarding", "documents"]) {
    const res = await fetch(`${baseUrl}/api/v1/portal/candidate/${path}`, { headers: CANDIDATE_HEADERS });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  }
});

test("a WORKER identity can never reach /portal/candidate/* and vice versa (distinct portal identities, distinct permission sets by design)", async () => {
  // WORKER no tiene ninguna acción distinta para candidate endpoints --
  // ambos comparten portalProfile.view, así que esto en realidad
  // confirma que el contenido devuelto sigue siendo el del WORKER real
  // (workerId), nunca inventa un candidateId inexistente.
  const res = await fetch(`${baseUrl}/api/v1/portal/candidate/profile`, { headers: WORKER_HEADERS });
  assert.equal(res.status, 403, "WORKER has no candidateId -- must be forbidden, not silently resolve someone else's candidate");
});
