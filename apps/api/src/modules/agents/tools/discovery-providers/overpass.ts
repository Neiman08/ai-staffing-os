import type { DiscoveredField, FieldStatus } from "@ai-staffing-os/agents";
import type { ProviderCandidate, ProviderSearchParams, ProviderSearchResult } from "./types";

/**
 * F4.5: Overpass (OpenStreetMap) — proveedor de RESPALDO gratuito, sin
 * API key. Desde F4.5 (integración de Google Places), este ya no es el
 * proveedor primario: el orquestador solo lo llama cuando Google Places
 * no está configurado, se quedó sin presupuesto, o no encontró nada para
 * esa industria. Ver docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md.
 */
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// Timeout/reintentos — ver el bugfix de ciclo de vida: sin esto, un
// fetch() que el servidor acepta pero nunca responde colgaba la tarea
// (y la misión) para siempre.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[discovery:overpass] ${event}`, JSON.stringify({ taskId, ...data }));
}

function isCancellation(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

// F4.5A §"Alcance prioritario": Manufacturing, Warehouse/Logistics,
// Construction — cada uno con más de un patrón de tag porque OSM no tiene
// una única convención por industria; se prueban en orden y se degrada
// por patrón (nunca se inventa un resultado si uno falla).
const OVERPASS_PATTERNS: Record<string, Array<{ key: string; value: string }>> = {
  Manufacturing: [{ key: "office", value: "company" }],
  "Warehouse/Logistics": [
    { key: "industrial", value: "warehouse" },
    { key: "building", value: "warehouse" },
  ],
  Construction: [
    { key: "craft", value: "builder" },
    { key: "office", value: "construction_company" },
  ],
};

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

async function fetchOverpassPattern(
  taskId: string,
  stateName: string,
  pattern: { key: string; value: string },
  limit: number,
  missionSignal: AbortSignal | undefined,
): Promise<{ elements: OverpassElement[] } | { error: string; cancelled?: boolean }> {
  const query = `[out:json][timeout:25];area["name"="${stateName}"]["admin_level"="4"]->.searchArea;(node["${pattern.key}"="${pattern.value}"](area.searchArea);way["${pattern.key}"="${pattern.value}"](area.searchArea););out center ${limit} tags;`;
  const patternLabel = `${pattern.key}=${pattern.value}`;

  // La instancia pública comparte cuota con el resto de internet —
  // 406/429/504 observados son fair-use throttling transitorio, no un
  // error de sintaxis.
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(missionSignal)) {
      log(taskId, "provider request cancelled", { pattern: patternLabel, attempt });
      return { error: "cancelled by user", cancelled: true };
    }

    log(taskId, "provider requested", { provider: "OpenStreetMap Overpass", pattern: patternLabel, attempt, maxAttempts: MAX_RETRIES });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = missionSignal ? AbortSignal.any([timeoutSignal, missionSignal]) : timeoutSignal;

    try {
      // "connection: close" fuerza una conexión TCP nueva en cada
      // intento — sin esto, fetch reutiliza keep-alive hacia el mismo
      // backend detrás del DNS round-robin de overpass-api.de.
      const res = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });

      log(taskId, "provider response", { pattern: patternLabel, attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return { error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as { elements: OverpassElement[] };
      return { elements: json.elements ?? [] };
    } catch (err) {
      if (missionSignal?.aborted) {
        log(taskId, "provider request cancelled mid-flight", { pattern: patternLabel, attempt });
        return { error: "cancelled by user", cancelled: true };
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "provider response", { pattern: patternLabel, attempt, error: errorLabel });

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
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

/**
 * Extrae campos de un elemento OSM crudo — cada campo queda CONFIRMED (si
 * el tag existe y pasa validación de formato), o NOT_FOUND. Nunca
 * INFERRED acá: OSM no da lugar a inferencia, solo lectura literal de
 * tags o ausencia. hiringSignals y contactos con nombre siempre son
 * NOT_FOUND — OSM no modela esos datos.
 */
export function extractFieldsFromOsmTags(
  tags: Record<string, string>,
  fallbackState: string,
): { name: string | null; fields: Record<string, DiscoveredField> } {
  const name = tags.name ?? tags.operator ?? null;

  const websiteRaw = tags.website ?? tags["contact:website"] ?? null;
  const website = websiteRaw && isValidUrl(websiteRaw) ? websiteRaw : null;

  const phoneRaw = tags.phone ?? tags["contact:phone"] ?? null;

  const emailRaw = tags.email ?? tags["contact:email"] ?? null;
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;

  const city = tags["addr:city"] ?? null;
  const state = tags["addr:state"] ?? fallbackState;
  const street = tags["addr:housenumber"] && tags["addr:street"] ? `${tags["addr:housenumber"]} ${tags["addr:street"]}` : (tags["addr:street"] ?? null);
  const postcode = tags["addr:postcode"] ?? null;
  const hasFullAddress = !!(street && city);

  return {
    name,
    fields: {
      name: name ? field("CONFIRMED", name) : field("NOT_FOUND", null),
      website: website ? field("CONFIRMED", website) : field("NOT_FOUND", null),
      phone: phoneRaw ? field("CONFIRMED", phoneRaw) : field("NOT_FOUND", null),
      email: email ? field("CONFIRMED", email) : field("NOT_FOUND", null),
      city: city ? field("CONFIRMED", city) : field("NOT_FOUND", null),
      state: state ? field("CONFIRMED", state) : field("NOT_FOUND", null),
      address: hasFullAddress ? field("CONFIRMED", `${street}, ${city}, ${state}${postcode ? ` ${postcode}` : ""}`) : field("NOT_FOUND", null),
      hiringSignals: field("NOT_FOUND", null),
      visiblePositions: field("NOT_FOUND", null),
      contactName: field("NOT_FOUND", null),
    },
  };
}

export async function searchOverpass(params: ProviderSearchParams): Promise<ProviderSearchResult> {
  const patterns = OVERPASS_PATTERNS[params.industryName] ?? [];
  const candidates: ProviderCandidate[] = [];
  const sourcesUsed = new Set<string>();
  const patternsFailed: string[] = [];

  for (const pattern of patterns) {
    if (candidates.length >= params.limit) break;
    if (isCancellation(params.abortSignal)) {
      return { candidates, costUsd: 0, sourcesUsed: Array.from(sourcesUsed), patternsFailed, cancelled: true };
    }

    const remaining = params.limit - candidates.length;
    const result = await fetchOverpassPattern(params.taskId, params.stateName, pattern, remaining * 3, params.abortSignal);
    if ("error" in result) {
      patternsFailed.push(`${params.industryName}:${pattern.key}=${pattern.value} (${result.error})`);
      if (result.cancelled) {
        return { candidates, costUsd: 0, sourcesUsed: Array.from(sourcesUsed), patternsFailed, cancelled: true };
      }
      continue;
    }

    const sourceUrl = `${OVERPASS_ENDPOINT}?data=${encodeURIComponent(`[${pattern.key}=${pattern.value}] area=${params.stateName}`)}`;
    sourcesUsed.add(`OpenStreetMap Overpass (${pattern.key}=${pattern.value}, ${params.stateName})`);
    log(params.taskId, "records found", { pattern: `${pattern.key}=${pattern.value}`, count: result.elements.length });

    for (const element of result.elements) {
      if (candidates.length >= params.limit) break;
      const tags = element.tags ?? {};
      const { name, fields } = extractFieldsFromOsmTags(tags, params.stateCode);
      candidates.push({ name, fields, sourceUrl });
    }
  }

  return { candidates, costUsd: 0, sourcesUsed: Array.from(sourcesUsed), patternsFailed, cancelled: false };
}
