// F12.4: confirma que helmet() está realmente montado en la app real
// (createApp(), no un clon) y que la configuración deliberada
// (contentSecurityPolicy apagada, crossOriginResourcePolicy en
// "cross-origin") quedó como se documentó en app.ts -- corre contra
// /api/v1/health (pública, sin necesitar ninguna identidad) para
// aislar el chequeo de headers de cualquier lógica de auth/tenancy.

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

test("headers de seguridad de helmet presentes en toda respuesta real", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-dns-prefetch-control"), "off");
  assert.equal(res.headers.get("x-powered-by"), null, "helmet debe quitar X-Powered-By: Express");
});

test("Content-Security-Policy desactivada a propósito (API JSON pura, nunca sirve HTML)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.headers.get("content-security-policy"), null);
});

test("Cross-Origin-Resource-Policy en cross-origin, nunca same-origin (rompería el fetch real del frontend en Render)", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
});
