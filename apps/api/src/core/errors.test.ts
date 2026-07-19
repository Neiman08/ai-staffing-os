// F12.12: hallazgo real de la validación final -- un body de más de
// 100kb (límite real de express.json(), ver app.ts/F12.4) devolvía un
// 500 "Something went wrong" genérico en vez del 413 real que
// body-parser ya reporta internamente. Corre contra la app real
// (createApp(), no un clon) para probar el middleware chain completo,
// no solo errorHandler en aislamiento.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../app";

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

test("un body de más de 100kb responde 413 real (PAYLOAD_TOO_LARGE), nunca un 500 genérico", async () => {
  const oversized = "a".repeat(200_000);
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: { "x-dev-user": "sales@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ instruction: oversized }),
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("un body dentro del límite nunca dispara el guard de tamaño (sigue el flujo normal de auth/permisos)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: { "x-dev-user": "compliance@titan.dev", "content-type": "application/json" },
    body: JSON.stringify({ instruction: "Busca empresas de construcción." }),
  });
  // compliance@titan.dev no tiene missions.create -- 403 real, nunca 413.
  assert.equal(res.status, 403);
});
