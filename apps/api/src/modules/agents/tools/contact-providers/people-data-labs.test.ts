import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { searchPeopleDataLabs } from "./people-data-labs";
import { resetProviderHealthForTests } from "../provider-health";

/**
 * F27 Fase 10: pruebas del cliente real de People Data Labs -- cero
 * llamadas de red reales (`global.fetch` reemplazado), mismo criterio
 * que microsoft-graph.test.ts. Cubre el hallazgo real que motivó toda la
 * Fase 6 de esta misión: un 402 real debe marcar el circuito
 * CREDIT_EXHAUSTED y la SIGUIENTE llamada (ej. la próxima empresa de la
 * misma misión) debe saltarse la red por completo, nunca repetir la
 * misma llamada condenada.
 */

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  resetProviderHealthForTests();
});

const FAKE_PARAMS = {
  taskId: "test-task",
  companyName: "Acme Electrical",
  companyWebsite: "https://acme-electrical.example",
  companyState: "IL",
  companyCity: "Chicago",
  industryName: "Construction",
  priorityTitles: ["Owner", "President"],
  limit: 4,
};

test("searchPeopleDataLabs: un 402 real marca CREDIT_EXHAUSTED, y la siguiente llamada nunca vuelve a tocar la red", async () => {
  let realFetchCalls = 0;
  globalThis.fetch = (async () => {
    realFetchCalls += 1;
    return new Response(JSON.stringify({ error: "account maximum for search — all matches used" }), { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const first = await searchPeopleDataLabs(FAKE_PARAMS, "fake-api-key");
  assert.equal(first.providerStatus, "CREDIT_EXHAUSTED");
  assert.equal(first.candidates.length, 0);
  assert.equal(realFetchCalls, 1);

  const second = await searchPeopleDataLabs(FAKE_PARAMS, "fake-api-key");
  assert.equal(second.providerStatus, "CREDIT_EXHAUSTED");
  assert.equal(realFetchCalls, 1, "la segunda empresa de la misma misión nunca debe repetir la llamada real ya condenada");
  assert.match(second.patternsFailed[0] ?? "", /no se reintenta/);
});

test("searchPeopleDataLabs: maxResults=0 (presupuesto agotado) nunca llega a tocar la red -- se omite antes de pedir nada", async () => {
  let realFetchCalls = 0;
  globalThis.fetch = (async () => {
    realFetchCalls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await searchPeopleDataLabs({ ...FAKE_PARAMS, maxResults: 0 }, "fake-api-key");

  assert.equal(realFetchCalls, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.providerStatus, "AVAILABLE", "un presupuesto agotado no es un fallo del proveedor -- nunca se marca CREDIT_EXHAUSTED por esto");
});

test("searchPeopleDataLabs: un 404 real (sin matches) es un resultado vacío honesto, nunca un error ni marca el circuito", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

  const result = await searchPeopleDataLabs(FAKE_PARAMS, "fake-api-key");

  assert.equal(result.providerStatus, "AVAILABLE");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.patternsFailed.length, 0);
});

test("searchPeopleDataLabs: maxResults reduce el size real pedido a PDL, nunca lo excede", async () => {
  let capturedSize: number | null = null;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as { size: number };
    capturedSize = body.size;
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await searchPeopleDataLabs({ ...FAKE_PARAMS, limit: 10, maxResults: 3 }, "fake-api-key");

  assert.equal(capturedSize, 3, "el techo de presupuesto (maxResults) siempre gana sobre la heurística interna (limit*5, hasta 20)");
});
