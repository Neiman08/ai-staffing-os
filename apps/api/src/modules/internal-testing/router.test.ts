import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../app";

/**
 * F27 (Internal Acceptance Test) -- pruebas reales a nivel HTTP contra la
 * app real (createApp()), nunca a OpenAI/Graph reales: ambos escenarios
 * de acá se resuelven ANTES de llegar a draftOutreach (uno se bloquea en
 * requirePermission, el otro en el chequeo de allowlist del propio
 * servicio) -- cero costo real, cero Company/Lead/Contact creados en el
 * caso 403 de permiso.
 */

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

test("un usuario sin permisos (Sales) nunca puede ejecutar la prueba interna -- 403 real por falta de permiso, nunca llega al chequeo de allowlist", async () => {
  const res = await fetch(`${baseUrl}/api/v1/internal-tests/acceptance`, {
    method: "POST",
    headers: { "x-dev-user": "sales@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ recipientEmail: "not-allowlisted@example.com", acceptanceTest: true, reason: "test" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /Missing permission/i);
});

test("un administrador SÍ pasa el chequeo de permiso -- llega al servicio real y es rechazado por un motivo DISTINTO (allowlist), nunca por falta de permiso", async () => {
  const res = await fetch(`${baseUrl}/api/v1/internal-tests/acceptance`, {
    method: "POST",
    headers: { "x-dev-user": "admin@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ recipientEmail: "not-allowlisted@example.com", acceptanceTest: true, reason: "test" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { message: string } };
  assert.doesNotMatch(body.error.message, /Missing permission/i, "un admin real nunca debe ver un 403 de permiso");
  assert.match(body.error.message, /allowlist/i);
});

test("un destinatario no autorizado (fuera de la allowlist) es rechazado -- nunca crea Company/Lead/Contact", async () => {
  const { prisma } = await import("@ai-staffing-os/db");
  const before1 = await prisma.company.count({ where: { origin: "INTERNAL_TEST" } });

  const res = await fetch(`${baseUrl}/api/v1/internal-tests/acceptance`, {
    method: "POST",
    headers: { "x-dev-user": "admin@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ recipientEmail: "definitely-not-allowlisted@example.com", acceptanceTest: true, reason: "test" }),
  });
  assert.equal(res.status, 403);

  const after1 = await prisma.company.count({ where: { origin: "INTERNAL_TEST" } });
  assert.equal(after1, before1, "un destinatario rechazado nunca debe dejar ninguna Company de prueba a medio crear");
});

test("acceptanceTest debe ser literalmente true -- un valor faltante o falso se rechaza por validación, nunca se interpreta como default", async () => {
  const res = await fetch(`${baseUrl}/api/v1/internal-tests/acceptance`, {
    method: "POST",
    headers: { "x-dev-user": "admin@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ recipientEmail: "neimangroupllc@gmail.com", reason: "test" }),
  });
  assert.equal(res.status, 400);
});
