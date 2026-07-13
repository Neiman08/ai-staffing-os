import type { DiscoveredField, FieldStatus } from "@ai-staffing-os/agents";
import type { ContactCandidate, ContactProviderSearchParams, ContactProviderSearchResult } from "./types";
import { classifyProviderHttpStatus, getProviderHealth, markProviderStatus } from "../provider-health";

const PROVIDER_KEY = "people_data_labs";

/**
 * F4.6: People Data Labs — Person Search API. Proveedor PRIMARIO del
 * Contact Intelligence Agent (free trial de créditos reales al crear la
 * cuenta, sin suscripción mensual — mismo motivo por el que se eligió
 * sobre Apollo.io para arrancar, ver docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md
 * y su addendum de contactos). Requiere PEOPLEDATALABS_API_KEY — si no
 * está configurada, el orquestador ni siquiera llama a este módulo.
 *
 * Docs: https://docs.peopledatalabs.com/docs/person-search-api
 */
const PDL_SEARCH_ENDPOINT = "https://api.peopledatalabs.com/v5/person/search";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];

// Estimado conservador: PDL cobra por registro de persona devuelto en un
// Search (no por request) — verificar contra el precio vigente en
// https://www.peopledatalabs.com/pricing antes de escalar volumen.
const COST_PER_MATCH_USD = 0.05;

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[contacts:people-data-labs] ${event}`, JSON.stringify({ taskId, ...data }));
}

function isCancellation(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value.startsWith("http") ? value : `https://${value}`);
    return true;
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(status: FieldStatus, value: string | number | null): DiscoveredField {
  return { status, value };
}

// F4.6 §"free tier oculta email/teléfono": PDL, según el plan asociado a
// la key, a veces devuelve estos campos como `true` (booleano — "existe
// en nuestros datos, pero no se te muestra en este plan") en vez del
// string real. Confirmado con una llamada real: work_email/emails/
// mobile_phone/phone_numbers vinieron como `true` para varios
// resultados. isRealString() es la guarda explícita — nunca se trata un
// booleano como si fuera el dato real, siempre NOT_FOUND en ese caso.
interface PdlPersonRecord {
  first_name?: unknown;
  last_name?: unknown;
  job_title?: unknown;
  job_company_name?: unknown;
  linkedin_url?: unknown;
  work_email?: unknown;
  emails?: unknown;
  mobile_phone?: unknown;
  phone_numbers?: unknown;
}

function isRealString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Antepone https:// si la fuente devolvió un dominio pelado (ej. "linkedin.com/in/x") — mismo valor real, solo formateado como URL válida. */
function normalizeUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

/**
 * Mapea un registro crudo de PDL a nuestro shape común de campos —
 * CONFIRMED cuando el dato viene literal de la respuesta COMO STRING y
 * pasa validación de formato, NOT_FOUND en cualquier otro caso (incluido
 * cuando el campo vino como `true`/`false` en vez del valor real — ver
 * arriba). Nunca se infiere ni se completa un dato que la fuente no trajo.
 */
export function extractFieldsFromPdlPerson(person: PdlPersonRecord): {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  fields: Record<string, DiscoveredField>;
} {
  const firstName = isRealString(person.first_name) ? person.first_name : null;
  const lastName = isRealString(person.last_name) ? person.last_name : null;
  const title = isRealString(person.job_title) ? person.job_title : null;

  const linkedinRaw = isRealString(person.linkedin_url) ? person.linkedin_url : null;
  const linkedinUrl = linkedinRaw && isValidUrl(linkedinRaw) ? normalizeUrl(linkedinRaw) : null;

  const emailsArray = Array.isArray(person.emails) ? person.emails : [];
  const emailFromArray = emailsArray.find((e): e is { address: string } => isRealString((e as { address?: unknown })?.address))?.address ?? null;
  const emailRaw = isRealString(person.work_email) ? person.work_email : emailFromArray;
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;

  const phoneNumbersArray = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
  const phoneFromArray = isRealString(phoneNumbersArray[0]) ? phoneNumbersArray[0] : null;
  const phone = isRealString(person.mobile_phone) ? person.mobile_phone : phoneFromArray;

  return {
    firstName,
    lastName,
    title,
    fields: {
      firstName: firstName ? field("CONFIRMED", firstName) : field("NOT_FOUND", null),
      lastName: lastName ? field("CONFIRMED", lastName) : field("NOT_FOUND", null),
      title: title ? field("CONFIRMED", title) : field("NOT_FOUND", null),
      linkedinUrl: linkedinUrl ? field("CONFIRMED", linkedinUrl) : field("NOT_FOUND", null),
      email: email ? field("CONFIRMED", email) : field("NOT_FOUND", null),
      phone: phone ? field("CONFIRMED", phone) : field("NOT_FOUND", null),
    },
  };
}

async function fetchPdlSearch(
  taskId: string,
  apiKey: string,
  companyName: string,
  size: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ people: PdlPersonRecord[] } | { error: string; cancelled?: boolean; httpStatus?: number }> {
  // Probado en vivo: PDL rechaza `minimum_should_match` dentro de `bool`
  // ("Query clause [minimum_should_match] not allowed or invalid field
  // name", HTTP 400) — no soporta esa cláusula de Elasticsearch estándar.
  // En vez de pelear con su DSL para filtrar por cargo en el request
  // (que además consumiría más créditos por intento fallido), se pide
  // por empresa nada más y el filtro de cargos prioritarios se aplica
  // client-side en el orquestador (mapTitleToDecisionRole) — mismo
  // resultado, cero llamadas extra, cero riesgo de otro 400.
  const query = {
    query: {
      bool: {
        must: [{ match: { job_company_name: companyName } }],
      },
    },
    size,
    pretty: false,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(abortSignal)) {
      log(taskId, "provider request cancelled", { companyName, attempt });
      return { error: "cancelled by user", cancelled: true };
    }

    log(taskId, "provider requested", { provider: "People Data Labs", companyName, attempt, maxAttempts: MAX_RETRIES });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(PDL_SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify(query),
        signal,
      });

      log(taskId, "provider response", { companyName, attempt, status: res.status, ok: res.ok });

      if (res.status === 404) {
        // PDL devuelve 404 cuando la búsqueda no matchea a nadie — no es
        // un error, es un resultado vacío real.
        return { people: [] };
      }
      if (!res.ok) {
        if (res.status < 500 && res.status !== 429) {
          const body = await res.text().catch(() => "");
          return { error: `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`, httpStatus: res.status };
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return { error: `HTTP ${res.status}`, httpStatus: res.status };
      }
      const json = (await res.json()) as { data?: PdlPersonRecord[] };
      return { people: json.data ?? [] };
    } catch (err) {
      if (abortSignal?.aborted) {
        log(taskId, "provider request cancelled mid-flight", { companyName, attempt });
        return { error: "cancelled by user", cancelled: true };
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "provider response", { companyName, attempt, error: errorLabel });

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
}

export async function searchPeopleDataLabs(
  params: ContactProviderSearchParams,
  apiKey: string,
): Promise<ContactProviderSearchResult> {
  // Corrección estructural (misión Iowa, 2026-07-13): antes de gastar un
  // request real, se chequea si esta cuenta ya se marcó CREDIT_EXHAUSTED/
  // UNAUTHORIZED/UNAVAILABLE hace poco — evita repetir la misma llamada
  // condenada por cada una de las N empresas de una misión (25 llamadas
  // idénticas a un 402 en el caso real que motivó este fix).
  const existingHealth = getProviderHealth(PROVIDER_KEY);
  if (existingHealth && existingHealth.status !== "AVAILABLE") {
    log(params.taskId, "provider skipped — marked unavailable", { provider: "People Data Labs", status: existingHealth.status, reason: existingHealth.reason });
    return {
      candidates: [],
      costUsd: 0,
      sourcesUsed: [],
      patternsFailed: [`People Data Labs: ${existingHealth.status} — ${existingHealth.reason} (no se reintenta por ~15 min para no repetir la misma llamada fallida en cada empresa)`],
      cancelled: false,
      providerStatus: existingHealth.status,
    };
  }

  // Se pide más de lo que hace falta (hasta 20) porque el filtro por
  // cargo prioritario se aplica client-side, DESPUÉS de esta llamada
  // (ver fetchPdlSearch) — sin margen, la mayoría de una empresa
  // (contadores, ingenieros, etc.) desplazaría a los cargos que sí
  // importan para ventas de staffing.
  const searchSize = Math.min(params.limit * 5, 20);
  const result = await fetchPdlSearch(params.taskId, apiKey, params.companyName, searchSize, params.abortSignal);

  if ("error" in result) {
    const providerStatus = result.httpStatus != null ? classifyProviderHttpStatus(result.httpStatus) : "AVAILABLE";
    if (providerStatus !== "AVAILABLE") {
      markProviderStatus(PROVIDER_KEY, providerStatus, result.error);
      log(params.taskId, "provider marked unavailable", { provider: "People Data Labs", status: providerStatus, reason: result.error });
    }
    return {
      candidates: [],
      costUsd: 0, // error real de la API — no se le cobra por un request fallido
      sourcesUsed: [],
      patternsFailed: [`${params.companyName}:people_data_labs_search (${result.error})`],
      cancelled: !!result.cancelled,
      providerStatus,
    };
  }

  log(params.taskId, "records found", { provider: "People Data Labs", companyName: params.companyName, count: result.people.length });

  const candidates: ContactCandidate[] = result.people.map((person) => {
    const { firstName, lastName, title, fields } = extractFieldsFromPdlPerson(person);
    const sourceUrl = fields.linkedinUrl?.status === "CONFIRMED" ? (fields.linkedinUrl.value as string) : null;
    return { firstName, lastName, title, fields, sourceUrl };
  });

  return {
    candidates,
    costUsd: result.people.length * COST_PER_MATCH_USD,
    sourcesUsed: candidates.length > 0 ? [`People Data Labs (${params.companyName})`] : [],
    patternsFailed: [],
    cancelled: false,
    providerStatus: "AVAILABLE",
  };
}
