import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp, parseOriginList } from "./app";

// F4.9 §10: cors() abierto (F0-F4.8) reemplazado por un allowlist
// explícito (APP_ORIGIN/MARKETING_ORIGIN, ver core/env.ts + app.ts) —
// este test verifica el comportamiento real, no solo que el código
// compile.

// F17 (dominio propio, transición): APP_ORIGIN/MARKETING_ORIGIN ahora
// aceptan una lista separada por comas -- prueba el parseo real en vez
// de solo confiar en que compile.
test("parseOriginList: un solo origen sin coma devuelve un array de un elemento (compatibilidad hacia atrás)", () => {
  assert.deepEqual(parseOriginList("https://app.dreistaff.com"), ["https://app.dreistaff.com"]);
});

test("parseOriginList: lista separada por comas devuelve todos los orígenes, sin espacios extra", () => {
  assert.deepEqual(parseOriginList("https://app.dreistaff.com, https://ai-staffing-os-web.onrender.com"), [
    "https://app.dreistaff.com",
    "https://ai-staffing-os-web.onrender.com",
  ]);
});

test("parseOriginList: comas repetidas o espacios en blanco nunca producen orígenes vacíos", () => {
  assert.deepEqual(parseOriginList("https://a.com,, https://b.com,  "), ["https://a.com", "https://b.com"]);
});
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

test("origin permitido (APP_ORIGIN default) recibe el header Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

test("origin permitido (MARKETING_ORIGIN default) recibe el header Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Origin: "http://localhost:5174" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5174");
});

test("origin arbitrario NO permitido: nunca recibe el header Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("preflight (OPTIONS) de un origin no permitido nunca refleja Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/users`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example.com",
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("sin header Origin (server-to-server, curl): la request igual responde 200 (no es un contexto de navegador)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
});

test("credentials nunca se habilitan (modelo Bearer token, no cookies cross-origin)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`, { headers: { Origin: "http://localhost:5173" } });
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});
