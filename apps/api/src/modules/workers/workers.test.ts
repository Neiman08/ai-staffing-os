import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

let server: Server;
let baseUrl: string;

const CEO_HEADERS = { "x-dev-user": "ceo@titan.dev", "content-type": "application/json" };
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

// F5.2: superficie mínima aprobada — solo GET /workers/:id existe en este
// bloque (sin listado, sin edición, sin filtros).

test("GET /workers/:id as sales@titan.dev returns 403 (no workers.view)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers/worker-does-not-matter`, { headers: SALES_HEADERS });
  assert.equal(res.status, 403);
});

test("GET /workers/:id for a nonexistent id returns 404", async () => {
  const res = await fetch(`${baseUrl}/api/v1/workers/does-not-exist`, { headers: CEO_HEADERS });
  assert.equal(res.status, 404);
});

test("GET /workers/:id for a real seeded Worker returns candidate link and documents with provenance", async () => {
  const seededWorker = await import("@ai-staffing-os/db").then(({ prisma }) =>
    prisma.worker.findFirstOrThrow(),
  );
  const res = await fetch(`${baseUrl}/api/v1/workers/${seededWorker.id}`, { headers: CEO_HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { candidateId: string; candidateName: string; documents: Array<{ source: string }> };
  assert.equal(body.candidateId, seededWorker.candidateId);
  assert.ok(body.candidateName.length > 0);
  for (const doc of body.documents) {
    assert.ok(doc.source === "worker" || doc.source === "candidate");
  }
});
