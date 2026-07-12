import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { authWebhookRouter } from "./webhook.router";

// F4.9: sin CLERK_WEBHOOK_SECRET real (bloqueado hasta que el PO cargue
// credenciales, F4.9-12) — este test verifica lo que SÍ se puede probar
// sin ellas: un request sin firma svix válida nunca llega a un handler,
// siempre 400. La firma real se verifica en F4.9-12 contra Clerk real.
let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use("/api/v1/auth", authWebhookRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("POST /auth/webhook sin headers svix → 400, nunca 200", async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user.created", data: { id: "user_fake" } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_SIGNATURE");
});
