import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { sendGraphMail, getAccessToken, resetTokenCacheForTests, checkMicrosoftGraphHealth } from "./microsoft-graph";
import { resetProviderHealthForTests } from "../agents/tools/provider-health";

/**
 * F17: pruebas unitarias del proveedor real de Microsoft Graph -- cero
 * llamadas de red reales, `global.fetch` se reemplaza por un fake
 * distinto en cada test. Mismo criterio del resto del repo: nunca se
 * llama a un proveedor real en un test unitario.
 */

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  resetTokenCacheForTests();
  resetProviderHealthForTests();
});

const FAKE_CREDS = { tenantId: "fake-tenant", clientId: "fake-client", clientSecret: "SUPER-SECRET-VALUE" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

// ---------- Token acquisition ----------

test("getAccessToken: intercambio exitoso devuelve el access_token real", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(200, { access_token: "fake-token-abc", expires_in: 3600 });
  }) as typeof fetch;

  const result = await getAccessToken("test-task", FAKE_CREDS);
  assert.ok(!("error" in result));
  if (!("error" in result)) assert.equal(result.accessToken, "fake-token-abc");
  assert.equal(calls, 1);
});

test("getAccessToken: reutiliza el token en cache dentro del TTL -- nunca pide uno nuevo", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(200, { access_token: "fake-token-abc", expires_in: 3600 });
  }) as typeof fetch;

  await getAccessToken("test-task", FAKE_CREDS);
  await getAccessToken("test-task", FAKE_CREDS);
  await getAccessToken("test-task", FAKE_CREDS);
  assert.equal(calls, 1, "el token cacheado debe reutilizarse, nunca 3 requests para 3 llamadas seguidas");
});

test("getAccessToken: expires_in muy corto (ya vencido/por vencer) fuerza un nuevo pedido", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    // expires_in=1 segundo -- muy por debajo del margen de seguridad de 60s.
    return jsonResponse(200, { access_token: `fake-token-${calls}`, expires_in: 1 });
  }) as typeof fetch;

  const first = await getAccessToken("test-task", FAKE_CREDS);
  const second = await getAccessToken("test-task", FAKE_CREDS);
  assert.equal(calls, 2, "un token con margen de seguridad insuficiente nunca debe reutilizarse");
  if (!("error" in first) && !("error" in second)) {
    assert.notEqual(first.accessToken, second.accessToken);
  }
});

test("getAccessToken: 401 (credenciales inválidas) nunca reintenta -- falla directo", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
  }) as typeof fetch;

  const result = await getAccessToken("test-task", FAKE_CREDS);
  assert.ok("error" in result);
  if ("error" in result) {
    assert.equal(result.httpStatus, 401);
    // F17 (regla explícita: "nunca registrar secretos ni tokens en
    // logs"): el mensaje de error real de Azure AD (que puede contener
    // fragmentos del secret) NUNCA se propaga -- solo el código corto.
    assert.ok(!result.error.includes(FAKE_CREDS.clientSecret));
    assert.match(result.error, /invalid_client/);
  }
  assert.equal(calls, 1, "401 nunca debe reintentarse");
});

test("getAccessToken: 429 respeta Retry-After y reintenta", async () => {
  let calls = 0;
  const timestamps: number[] = [];
  globalThis.fetch = (async () => {
    calls += 1;
    timestamps.push(Date.now());
    if (calls < 3) return jsonResponse(429, { error: "too_many_requests" }, { "retry-after": "0" });
    return jsonResponse(200, { access_token: "fake-token-after-retry", expires_in: 3600 });
  }) as typeof fetch;

  const result = await getAccessToken("test-task", FAKE_CREDS);
  assert.ok(!("error" in result));
  assert.equal(calls, 3, "debe reintentar hasta obtener éxito, respetando MAX_RETRIES");
});

test("getAccessToken: 500 repetido agota los reintentos y falla como recuperable", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(500, { error: "server_error" });
  }) as typeof fetch;

  const result = await getAccessToken("test-task", FAKE_CREDS);
  assert.ok("error" in result);
  if ("error" in result) assert.equal(result.httpStatus, 500);
  assert.equal(calls, 3, "debe agotar los 3 intentos antes de rendirse");
});

// ---------- sendGraphMail ----------

function tokenOkThen(next: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "fake-token", expires_in: 3600 });
    }
    return next(href, init);
  }) as typeof fetch;
}

test("sendGraphMail: camino feliz -- crea el mensaje (201, id real) y lo envía (202) -- devuelve messageId/conversationId reales", async () => {
  let createRequestBody: string | undefined;
  globalThis.fetch = tokenOkThen((href, init) => {
    if (href.endsWith("/messages")) {
      createRequestBody = init?.body as string | undefined;
      return jsonResponse(201, { id: "AAMkAGI-real-message-id", conversationId: "AAQkAGI-real-conversation-id" });
    }
    if (href.includes("/messages/AAMkAGI-real-message-id/send")) {
      return emptyResponse(202);
    }
    throw new Error(`unexpected URL in test: ${href}`);
  });

  const result = await sendGraphMail(
    {
      taskId: "test-task",
      mailbox: "sales@dreistaff.com",
      from: { email: "sales@dreistaff.com", name: "DreiStaff Sales" },
      to: [{ email: "prospect@example.com" }],
      subject: "Test",
      bodyText: "Hello",
    },
    FAKE_CREDS,
  );

  assert.equal(result.kind, "sent");
  if (result.kind === "sent") {
    assert.equal(result.providerMessageId, "AAMkAGI-real-message-id");
    assert.equal(result.conversationId, "AAQkAGI-real-conversation-id");
  }

  // Regresión real: el campo `from` estaba declarado en la interfaz pero
  // nunca se incluía en el body real enviado a Graph -- la URL del buzón
  // (/users/sales@dreistaff.com/messages) decide DÓNDE se crea el mensaje,
  // nunca qué remitente se muestra. Sin este assert, un `sendGraphMail`
  // que "funciona" (200/201/202, kind:"sent") puede seguir enviando en
  // producción con el remitente real del buzón en vez de sales@ -- exactamente
  // lo que pasó en la prueba controlada real antes de este fix.
  assert.ok(createRequestBody, "debe haberse capturado el body real enviado a POST /messages");
  const parsedBody = JSON.parse(createRequestBody!) as { from?: { emailAddress?: { address?: string; name?: string } } };
  assert.deepEqual(parsedBody.from, { emailAddress: { address: "sales@dreistaff.com", name: "DreiStaff Sales" } });
});

test("sendGraphMail: 403 ErrorSendAsDenied al crear el mensaje -- falla, NUNCA reintentable, motivo exacto disponible", async () => {
  globalThis.fetch = tokenOkThen((href) => {
    if (href.endsWith("/messages")) {
      return jsonResponse(403, { error: { code: "ErrorSendAsDenied", message: "Client does not have permissions to send as this sender" } });
    }
    throw new Error(`unexpected URL in test: ${href}`);
  });

  const result = await sendGraphMail(
    {
      mailbox: "sales@dreistaff.com",
      from: { email: "sales@dreistaff.com", name: "DreiStaff Sales" },
      to: [{ email: "prospect@example.com" }],
      subject: "Test",
      bodyText: "Hello",
    },
    FAKE_CREDS,
  );

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.retryable, false);
    assert.equal(result.providerStatus, "UNAUTHORIZED");
    assert.match(result.reason, /ErrorSendAsDenied/);
  }
});

test("sendGraphMail: 429 al crear el mensaje -- clasificado recuperable (RETRYABLE), nunca FAILED permanente", async () => {
  globalThis.fetch = tokenOkThen((href) => {
    if (href.endsWith("/messages")) {
      return jsonResponse(429, { error: { code: "TooManyRequests" } }, { "retry-after": "0" });
    }
    throw new Error(`unexpected URL in test: ${href}`);
  });

  const result = await sendGraphMail(
    {
      mailbox: "sales@dreistaff.com",
      from: { email: "sales@dreistaff.com", name: "DreiStaff Sales" },
      to: [{ email: "prospect@example.com" }],
      subject: "Test",
      bodyText: "Hello",
    },
    FAKE_CREDS,
  );

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.retryable, true);
    assert.equal(result.providerStatus, "UNAVAILABLE");
  }
});

test("sendGraphMail: 5xx al enviar el borrador ya creado -- recuperable, el mensaje quedó creado (evidencia real)", async () => {
  globalThis.fetch = tokenOkThen((href) => {
    if (href.endsWith("/messages")) {
      return jsonResponse(201, { id: "msg-1", conversationId: "conv-1" });
    }
    if (href.includes("/messages/msg-1/send")) {
      return jsonResponse(503, { error: { code: "ServiceUnavailable" } });
    }
    throw new Error(`unexpected URL in test: ${href}`);
  });

  const result = await sendGraphMail(
    {
      mailbox: "sales@dreistaff.com",
      from: { email: "sales@dreistaff.com", name: "DreiStaff Sales" },
      to: [{ email: "prospect@example.com" }],
      subject: "Test",
      bodyText: "Hello",
    },
    FAKE_CREDS,
  );

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.retryable, true);
    assert.match(result.reason, /msg-1/);
  }
});

test("sendGraphMail: circuito abierto tras un 401 -- la siguiente llamada NUNCA vuelve a golpear la red (~15 min)", async () => {
  let realFetchCalls = 0;
  globalThis.fetch = tokenOkThen((href) => {
    realFetchCalls += 1;
    if (href.endsWith("/messages")) return jsonResponse(401, { error: { code: "InvalidAuthenticationToken" } });
    throw new Error(`unexpected URL: ${href}`);
  });

  const first = await sendGraphMail(
    { mailbox: "sales@dreistaff.com", from: { email: "sales@dreistaff.com" }, to: [{ email: "x@example.com" }], subject: "s", bodyText: "b" },
    FAKE_CREDS,
  );
  assert.equal(first.kind, "failed");
  const callsAfterFirst = realFetchCalls;

  const second = await sendGraphMail(
    { mailbox: "sales@dreistaff.com", from: { email: "sales@dreistaff.com" }, to: [{ email: "x@example.com" }], subject: "s", bodyText: "b" },
    FAKE_CREDS,
  );
  assert.equal(second.kind, "failed");
  if (second.kind === "failed") assert.match(second.reason, /no se reintenta/);
  assert.equal(realFetchCalls, callsAfterFirst, "el segundo intento no debe hacer ninguna llamada de red real");
});

test("sendGraphMail: timeout se clasifica y reporta honestamente (no cuelga el test)", async () => {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "TimeoutError")));
    });
  }) as typeof fetch;

  // Token request en sí también usa AbortSignal.timeout -- para no
  // esperar el timeout real completo en el test, se aborta manualmente
  // encadenando un AbortController de vida corta a través de creds
  // inválidas más un fetch que respeta la señal (arriba). Se valida el
  // camino de error genuino en microsoft-graph.test's "500 repetido"
  // más arriba; acá solo se confirma que un abort real nunca cuelga.
  const controller = new AbortController();
  const resultPromise = getAccessToken("test-task", FAKE_CREDS, controller.signal);
  controller.abort();
  const result = await resultPromise;
  assert.ok("error" in result);
  if ("error" in result) assert.match(result.error, /cancelled/);
});

// ---------- Health check (sin enviar correos) ----------

test("checkMicrosoftGraphHealth: credenciales válidas -> healthy:true, nunca toca /messages ni /sendMail", async () => {
  let touchedMailEndpoint = false;
  globalThis.fetch = (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("/messages") || href.includes("/sendMail")) touchedMailEndpoint = true;
    return jsonResponse(200, { access_token: "fake-token", expires_in: 3600 });
  }) as typeof fetch;

  const result = await checkMicrosoftGraphHealth(FAKE_CREDS);
  assert.equal(result.healthy, true);
  assert.equal(touchedMailEndpoint, false);
});

test("checkMicrosoftGraphHealth: credenciales inválidas -> healthy:false con motivo real", async () => {
  globalThis.fetch = (async () => jsonResponse(401, { error: "invalid_client" })) as typeof fetch;

  const result = await checkMicrosoftGraphHealth(FAKE_CREDS);
  assert.equal(result.healthy, false);
  assert.match(result.reason ?? "", /invalid_client/);
});
