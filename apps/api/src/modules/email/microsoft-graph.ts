import type { ProviderStatusValue } from "@ai-staffing-os/agents";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "../agents/tools/provider-health";

/**
 * F17: Microsoft Graph -- proveedor real de envío de email, OAuth2 Client
 * Credentials (app-only). Mismo criterio exacto que el resto de
 * proveedores externos del repo (hunter.ts/people-data-labs.ts/
 * google-places.ts): fetch nativo (sin SDK nuevo), timeout + reintentos
 * con backoff, y provider-health.ts (circuit breaker compartido, TTL de
 * 15 min) para no repetir la misma llamada condenada.
 *
 * Nunca usa /me/sendMail (eso es delegated, requiere un usuario con
 * sesión) -- este flujo es app-only, siempre `/users/{mailbox}/...`.
 *
 * Diseño de 2 pasos (crear borrador + enviarlo) en vez de POST
 * /sendMail de un solo paso: `/sendMail` devuelve 202 sin cuerpo, JAMÁS
 * un messageId -- no hay forma de cumplir "devolver el identificador del
 * mensaje" con esa llamada. Crear el mensaje primero (POST /messages,
 * responde 201 con `id`/`conversationId` reales) y después enviarlo
 * (POST /messages/{id}/send) sí lo permite, y Graph mueve el mensaje a
 * Sent Items automáticamente al enviarlo (comportamiento documentado,
 * no hace falta `saveToSentItems` -- ese flag es exclusivo de
 * /sendMail).
 */

const PROVIDER_KEY = "microsoft_graph_email";
const TOKEN_ENDPOINT_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];
// Margen de seguridad antes de la expiración real del token -- nunca se
// usa un token a los 0 segundos de vencer, evita una carrera real contra
// el reloj del proveedor.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function log(taskId: string | undefined, event: string, data?: Record<string, unknown>): void {
  // F17 (regla de seguridad explícita del pedido: "nunca registrar
  // secretos ni tokens en logs"): este helper nunca recibe accessToken/
  // client secret como argumento en absoluto -- ningún llamador de este
  // archivo puede filtrarlos por accidente acá, la firma misma lo impide.
  console.log(`[email:microsoft-graph] ${event}`, JSON.stringify({ taskId, ...data }));
}

function isCancellation(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Cache de token en memoria del proceso -- un solo token de aplicación
// compartido por todos los envíos hasta que expire, nunca se pide uno
// nuevo por cada email (Client Credentials típicamente da tokens de ~60
// min). `resetTokenCacheForTests` es la única forma de limpiarlo, nunca
// se expone en la respuesta de ninguna función real.
let cachedToken: CachedToken | null = null;

export function resetTokenCacheForTests(): void {
  cachedToken = null;
}

interface TokenFetchError {
  error: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function fetchAccessToken(
  taskId: string | undefined,
  creds: GraphCredentials,
  abortSignal: AbortSignal | undefined,
): Promise<{ accessToken: string; expiresInSec: number } | TokenFetchError> {
  const url = `${TOKEN_ENDPOINT_BASE}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: GRAPH_SCOPE,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(abortSignal)) return { error: "cancelled by user" };

    log(taskId, "token requested", { attempt, maxAttempts: MAX_RETRIES });
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal,
      });
      log(taskId, "token response", { attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        // Nunca se registra el cuerpo del error acá -- Azure AD a veces
        // devuelve fragmentos del client_secret en mensajes de error de
        // depuración ("AADSTS7000215: Invalid client secret provided...").
        // Se guarda solo el código de error real de Azure AD (ej.
        // "invalid_client"), nunca el texto completo.
        let errorCode = `HTTP ${res.status}`;
        try {
          const json = (await res.json()) as { error?: string };
          if (json.error) errorCode = `${errorCode} (${json.error})`;
        } catch {
          /* cuerpo no-JSON, se ignora -- nunca se loguea texto crudo */
        }
        if (res.status === 429 || res.status >= 500) {
          const retryAfterMs = parseRetryAfterMs(res);
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, retryAfterMs ?? BACKOFF_MS[attempt - 1]));
            continue;
          }
          return { error: errorCode, httpStatus: res.status, retryAfterMs: retryAfterMs ?? undefined };
        }
        return { error: errorCode, httpStatus: res.status };
      }

      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) return { error: "token response missing access_token" };
      return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 3600 };
    } catch (err) {
      if (abortSignal?.aborted) return { error: "cancelled by user" };
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "token response", { attempt, error: errorLabel });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
}

/**
 * Devuelve un access token válido, reutilizando el cache mientras no
 * esté por expirar. Nunca se loguea el token en sí -- solo eventos de
 * "se pidió"/"se reutilizó"/"expiró", nunca el valor.
 */
export async function getAccessToken(
  taskId: string | undefined,
  creds: GraphCredentials,
  abortSignal?: AbortSignal,
): Promise<{ accessToken: string } | TokenFetchError> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    log(taskId, "token reused from cache");
    return { accessToken: cachedToken.accessToken };
  }

  const result = await fetchAccessToken(taskId, creds, abortSignal);
  if ("error" in result) return result;

  cachedToken = { accessToken: result.accessToken, expiresAt: Date.now() + result.expiresInSec * 1000 };
  log(taskId, "token acquired", { expiresInSec: result.expiresInSec });
  return { accessToken: result.accessToken };
}

export interface GraphEmailAddress {
  email: string;
  name?: string;
}

export interface SendGraphMailParams {
  taskId?: string;
  mailbox: string; // ej. "sales@dreistaff.com" -- SIEMPRE /users/{mailbox}, nunca /me
  from: GraphEmailAddress; // remitente visible (mailbox y from.email deben coincidir -- ver sender-profiles.ts)
  to: GraphEmailAddress[];
  cc?: GraphEmailAddress[];
  bcc?: GraphEmailAddress[];
  replyTo?: GraphEmailAddress[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  abortSignal?: AbortSignal;
}

export type SendGraphMailResult =
  | { kind: "sent"; providerMessageId: string; conversationId: string | null }
  | { kind: "failed"; reason: string; retryable: boolean; httpStatus?: number; providerStatus: ProviderStatusValue };

function graphRecipients(addresses: GraphEmailAddress[] | undefined): Array<{ emailAddress: { address: string; name?: string } }> {
  return (addresses ?? []).map((a) => ({ emailAddress: { address: a.email, name: a.name } }));
}

async function graphFetch(
  taskId: string | undefined,
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown },
  abortSignal: AbortSignal | undefined,
): Promise<{ status: number; json: unknown } | TokenFetchError> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(abortSignal)) return { error: "cancelled by user" };

    log(taskId, "graph request", { path, method: init.method, attempt, maxAttempts: MAX_RETRIES });
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          // Sin esto, el `id` de un mensaje cambia en cuanto Graph lo mueve
          // de Drafts a Sent Items al enviarlo (comportamiento real
          // confirmado: el id devuelto por el paso de creación dejó de
          // existir segundos después del envío real) -- el id inmutable es
          // el único que sigue siendo válido para lookups posteriores
          // (Sent Items, threading) tras ese movimiento de carpeta.
          prefer: 'IdType="ImmutableId"',
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal,
      });
      log(taskId, "graph response", { path, attempt, status: res.status, ok: res.ok });

      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfterMs(res);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, retryAfterMs ?? BACKOFF_MS[attempt - 1]));
          continue;
        }
        return { error: `HTTP ${res.status}`, httpStatus: res.status, retryAfterMs: retryAfterMs ?? undefined };
      }

      if (!res.ok) {
        let detail = "";
        try {
          // F17 (pedido explícito: "reporta exactamente qué permiso o
          // configuración falta"): antes solo se guardaba `error.code`
          // (ej. "ErrorAccessDenied"), un código genérico que no dice
          // POR QUÉ -- `error.message` de Graph suele nombrar el permiso
          // real que falta (ej. "Application is missing required
          // permission Mail.ReadWrite..."). Nunca contiene secretos
          // (es texto de error de la API de Microsoft, no credenciales) --
          // se trunca igual, nunca se asume que es corto.
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          const code = body.error?.code ?? "";
          const message = body.error?.message ?? "";
          detail = [code, message].filter(Boolean).join(": ").slice(0, 500);
        } catch {
          /* cuerpo no-JSON, se ignora */
        }
        return { error: detail ? `HTTP ${res.status} (${detail})` : `HTTP ${res.status}`, httpStatus: res.status };
      }

      const json = res.status === 202 || res.status === 204 ? null : ((await res.json().catch(() => null)) as unknown);
      return { status: res.status, json };
    } catch (err) {
      if (abortSignal?.aborted) return { error: "cancelled by user" };
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "graph response", { path, attempt, error: errorLabel });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
}

/**
 * Envía un email real vía Microsoft Graph, app-only, mailbox explícito
 * (nunca /me). 2 pasos reales: crea el mensaje (obtiene id/conversationId
 * reales) y lo envía -- Graph lo mueve a Sent Items automáticamente al
 * enviarlo. Nunca marca "sent" sin la confirmación real de ambos pasos.
 */
export async function sendGraphMail(params: SendGraphMailParams, creds: GraphCredentials): Promise<SendGraphMailResult> {
  const existingHealth = getProviderHealth(PROVIDER_KEY);
  if (existingHealth && existingHealth.status !== "AVAILABLE") {
    return {
      kind: "failed",
      reason: `Microsoft Graph: ${existingHealth.status} — ${existingHealth.reason} (no se reintenta por ~15 min)`,
      retryable: existingHealth.status === "UNAVAILABLE",
      providerStatus: existingHealth.status,
    };
  }

  const tokenResult = await getAccessToken(params.taskId, creds, params.abortSignal);
  if ("error" in tokenResult) {
    const providerStatus = tokenResult.httpStatus != null ? classifyProviderHttpStatus(tokenResult.httpStatus) : "UNAVAILABLE";
    if (providerStatus !== "AVAILABLE") markProviderStatus(PROVIDER_KEY, providerStatus, tokenResult.error);
    return {
      kind: "failed",
      reason: `token: ${tokenResult.error}`,
      retryable: providerStatus === "UNAVAILABLE",
      httpStatus: tokenResult.httpStatus,
      providerStatus,
    };
  }

  if (params.bodyHtml == null && params.bodyText == null) {
    return { kind: "failed", reason: "sendGraphMail: falta bodyHtml o bodyText", retryable: false, providerStatus: "AVAILABLE" };
  }
  const body = params.bodyHtml != null ? { contentType: "HTML", content: params.bodyHtml } : { contentType: "Text", content: params.bodyText };

  const message = {
    subject: params.subject,
    body,
    // F17 (bug real encontrado en la prueba controlada de producción):
    // sin esto, Exchange usa la identidad propia del buzón como remitente
    // visible en vez del alias/dirección pedido -- confirmado en vivo,
    // el envío real llegó como "hello@dreistaff.com" (el dueño real del
    // buzón) en lugar de "sales@dreistaff.com" pese a que la llamada ya
    // apuntaba a /users/sales@dreistaff.com/messages. La URL del buzón
    // solo decide DÓNDE se crea el mensaje, nunca qué remitente se
    // muestra -- eso lo decide únicamente este campo.
    from: { emailAddress: { address: params.from.email, name: params.from.name } },
    toRecipients: graphRecipients(params.to),
    ccRecipients: graphRecipients(params.cc),
    bccRecipients: graphRecipients(params.bcc),
    replyTo: graphRecipients(params.replyTo && params.replyTo.length > 0 ? params.replyTo : undefined),
  };

  const mailboxPath = `/users/${encodeURIComponent(params.mailbox)}`;

  // Paso 1: crear el mensaje como borrador -- única forma de obtener un
  // id/conversationId reales (ver comentario de diseño arriba).
  const createResult = await graphFetch(params.taskId, tokenResult.accessToken, `${mailboxPath}/messages`, { method: "POST", body: message }, params.abortSignal);
  if ("error" in createResult) {
    const providerStatus = createResult.httpStatus != null ? classifyProviderHttpStatus(createResult.httpStatus) : "UNAVAILABLE";
    if (providerStatus !== "AVAILABLE") markProviderStatus(PROVIDER_KEY, providerStatus, createResult.error);
    return {
      kind: "failed",
      reason: `create message: ${createResult.error}`,
      retryable: providerStatus === "UNAVAILABLE",
      httpStatus: createResult.httpStatus,
      providerStatus,
    };
  }

  const created = createResult.json as { id?: string; conversationId?: string } | null;
  const messageId = created?.id;
  if (!messageId) {
    return { kind: "failed", reason: "create message: respuesta sin id real", retryable: false, providerStatus: "AVAILABLE" };
  }

  // Paso 2: enviar el borrador ya creado.
  const sendResult = await graphFetch(params.taskId, tokenResult.accessToken, `${mailboxPath}/messages/${encodeURIComponent(messageId)}/send`, { method: "POST" }, params.abortSignal);
  if ("error" in sendResult) {
    const providerStatus = sendResult.httpStatus != null ? classifyProviderHttpStatus(sendResult.httpStatus) : "UNAVAILABLE";
    if (providerStatus !== "AVAILABLE") markProviderStatus(PROVIDER_KEY, providerStatus, sendResult.error);
    return {
      kind: "failed",
      reason: `send message ${messageId}: ${sendResult.error}`,
      retryable: providerStatus === "UNAVAILABLE",
      httpStatus: sendResult.httpStatus,
      providerStatus,
    };
  }

  log(params.taskId, "mail sent", { mailbox: params.mailbox, messageId, conversationId: created?.conversationId ?? null });
  return { kind: "sent", providerMessageId: messageId, conversationId: created?.conversationId ?? null };
}

/**
 * F17 (pedido explícito: "una comprobación de salud del proveedor sin
 * enviar correos"): solo intenta obtener un token real -- prueba que
 * las credenciales son válidas sin tocar ningún mailbox ni crear/enviar
 * ningún mensaje. Nunca cuenta como "intento de envío" en provider-health.
 */
export async function checkMicrosoftGraphHealth(creds: GraphCredentials): Promise<{ healthy: boolean; reason: string | null }> {
  const result = await getAccessToken(undefined, creds);
  if ("error" in result) return { healthy: false, reason: result.error };
  return { healthy: true, reason: null };
}

export interface DeliveryInvestigationResult {
  foundInSentItems: boolean;
  detail: string;
  subject: string | null;
  toRecipients: string[];
  sentDateTime: string | null;
  internetMessageId: string | null;
  from: string | null;
  possibleNdrs: Array<{ subject: string; receivedDateTime: string | null; from: string | null }>;
}

/**
 * Reintroducido de forma puntual y autorizada explícitamente por el
 * usuario ("autoriza un cambio de código puntual para reintroducir la
 * verificación de Graph") -- investigación real de un correo no
 * recibido: confirma ubicación en Sent Items, recupera destinatario/
 * asunto/hora/internetMessageId reales, y busca en el Inbox cualquier
 * NDR (Non-Delivery Report) real llegado después del envío. Sola
 * lectura, nunca envía ni crea nada. Se elimina de nuevo una vez
 * concluida esta investigación puntual (mismo criterio que el resto de
 * herramientas de diagnóstico de esta integración).
 */
export async function investigateDelivery(mailbox: string, messageId: string, sentAtIso: string, creds: GraphCredentials): Promise<DeliveryInvestigationResult> {
  const tokenResult = await getAccessToken(undefined, creds);
  if ("error" in tokenResult) {
    return { foundInSentItems: false, detail: `token: ${tokenResult.error}`, subject: null, toRecipients: [], sentDateTime: null, internetMessageId: null, from: null, possibleNdrs: [] };
  }

  const msgPath = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=id,subject,sentDateTime,parentFolderId,from,toRecipients,internetMessageId`;
  const msgResult = await graphFetch(undefined, tokenResult.accessToken, msgPath, { method: "GET" }, undefined);
  if ("error" in msgResult) {
    return { foundInSentItems: false, detail: `message lookup: ${msgResult.error}`, subject: null, toRecipients: [], sentDateTime: null, internetMessageId: null, from: null, possibleNdrs: [] };
  }
  const message = msgResult.json as {
    id?: string;
    subject?: string;
    sentDateTime?: string;
    parentFolderId?: string;
    internetMessageId?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  } | null;
  if (!message?.id) {
    return { foundInSentItems: false, detail: "mensaje no encontrado en el buzón", subject: null, toRecipients: [], sentDateTime: null, internetMessageId: null, from: null, possibleNdrs: [] };
  }

  const folderResult = await graphFetch(undefined, tokenResult.accessToken, `/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems?$select=id`, { method: "GET" }, undefined);
  const folder = "error" in folderResult ? null : (folderResult.json as { id?: string } | null);
  const inSentItems = !!folder?.id && message.parentFolderId === folder.id;

  const ndrPath = `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${sentAtIso}`)}&$select=subject,receivedDateTime,from&$top=25`;
  const ndrResult = await graphFetch(undefined, tokenResult.accessToken, ndrPath, { method: "GET" }, undefined);
  const ndrBody = "error" in ndrResult ? null : (ndrResult.json as { value?: Array<{ subject?: string; receivedDateTime?: string; from?: { emailAddress?: { address?: string } } }> } | null);
  const possibleNdrs = (ndrBody?.value ?? [])
    .filter((m) => {
      const subj = (m.subject ?? "").toLowerCase();
      const fromAddr = (m.from?.emailAddress?.address ?? "").toLowerCase();
      return subj.includes("undeliverable") || subj.includes("delivery status") || subj.includes("failure") || fromAddr.includes("postmaster") || fromAddr.includes("mailer-daemon");
    })
    .map((m) => ({ subject: m.subject ?? "", receivedDateTime: m.receivedDateTime ?? null, from: m.from?.emailAddress?.address ?? null }));

  const realFrom = message.from?.emailAddress ? `${message.from.emailAddress.name ?? ""} <${message.from.emailAddress.address ?? ""}>` : null;
  const toRecipients = (message.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean);

  return {
    foundInSentItems: inSentItems,
    detail: `parentFolderId=${message.parentFolderId ?? "n/a"}, sentItemsFolderId=${folder?.id ?? "n/a"}${"error" in ndrResult ? `, ndr lookup error: ${ndrResult.error}` : ""}`,
    subject: message.subject ?? null,
    toRecipients,
    sentDateTime: message.sentDateTime ?? null,
    internetMessageId: message.internetMessageId ?? null,
    from: realFrom,
    possibleNdrs,
  };
}
