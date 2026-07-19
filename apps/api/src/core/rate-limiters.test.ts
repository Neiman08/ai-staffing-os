// F12.4: prueba el MECANISMO de rate limiting con un clon de límite bajo
// (nunca los límites reales de producción -- disparar 20-30 requests
// reales a /missions costaría OpenAI real y sería lento) montado sobre
// una app Express descartable con un handler trivial. Las pruebas de
// "wiring" real (el limiter de producción está montado en la ruta real)
// viven en cada test file de la ruta protegida (missions.test.ts,
// analytics/export.test.ts, user-management.test.ts) verificando el
// header RateLimit-Limit real, sin agotar el cupo.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import rateLimit from "express-rate-limit";

function buildTestApp(limit: number) {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests." } },
  });
  app.get("/probe", limiter, (_req, res) => res.json({ ok: true }));
  return app;
}

async function requestProbe(app: express.Express): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no address"));
      fetch(`http://localhost:${address.port}/probe`)
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch(reject);
    });
  });
}

test("rate limiter: dentro del límite, siempre 200", async () => {
  const app = buildTestApp(3);
  for (let i = 0; i < 3; i++) {
    const { status } = await requestProbe(app);
    assert.equal(status, 200);
  }
});

test("rate limiter: al superar el límite en la misma ventana, 429 con el cuerpo de error real (mismo formato que core/errors.ts)", async () => {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests." } },
  });
  app.get("/probe", limiter, (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://localhost:${address.port}`;

  try {
    const r1 = await fetch(`${baseUrl}/probe`);
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${baseUrl}/probe`);
    assert.equal(r2.status, 200);
    const r3 = await fetch(`${baseUrl}/probe`);
    assert.equal(r3.status, 429);
    const body = (await r3.json()) as { error: { code: string } };
    assert.equal(body.error.code, "RATE_LIMITED");
  } finally {
    server.close();
  }
});

test("rate limiter: expone RateLimit-Limit/RateLimit-Remaining (standardHeaders), nunca los legacy X-RateLimit-*", async () => {
  const app = buildTestApp(5);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    const res = await fetch(`http://localhost:${address.port}/probe`);
    assert.equal(res.headers.get("ratelimit-limit"), "5");
    assert.equal(res.headers.get("x-ratelimit-limit"), null);
  } finally {
    server.close();
  }
});
