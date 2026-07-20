import type { DiscoveredField, FieldStatus } from "@ai-staffing-os/agents";
import type { ProviderCandidate, ProviderSearchParams, ProviderSearchResult } from "./types";

/**
 * F4.5: Google Places API (New) — Text Search. Proveedor PRIMARIO del
 * Discovery Agent a partir de F4.5 (Overpass pasa a ser el respaldo
 * gratuito, ver overpass.ts). Requiere GOOGLE_PLACES_API_KEY — si no está
 * configurada, el orquestador (discovery-tools.impl.ts) ni siquiera llama
 * a este módulo, va directo a Overpass.
 *
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 */
const PLACES_TEXT_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

// Timeout/reintentos — mismo patrón que Overpass (bugfix de ciclo de
// vida: ninguna llamada de red real puede quedar esperando para siempre).
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 5000, 10000];

// Estimado conservador de la tarifa "Pro" de Text Search (incluye
// dirección, teléfono, sitio web) — verificar contra el precio vigente en
// https://mapsplatform.google.com/pricing/ antes de escalar volumen real.
// Se cobra por REQUEST, no por resultado devuelto.
const TEXT_SEARCH_COST_PER_REQUEST_USD = 0.032;

// Google entiende texto libre razonablemente bien — a diferencia de
// Overpass no hace falta un tag por convención de mapeo, alcanza con una
// frase de búsqueda por industria.
const INDUSTRY_QUERY_PHRASES: Record<string, string> = {
  Manufacturing: "manufacturing company",
  "Warehouse/Logistics": "warehouse or logistics company",
  Construction: "construction company",
};

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.types",
  "places.businessStatus",
].join(",");

interface GooglePlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types: string[];
}

interface GooglePlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: GooglePlacesAddressComponent[];
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  types?: string[];
  businessStatus?: string;
}

function log(taskId: string, event: string, data?: Record<string, unknown>): void {
  console.log(`[discovery:google-places] ${event}`, JSON.stringify({ taskId, ...data }));
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

function field(status: FieldStatus, value: string | number | null): DiscoveredField {
  return { status, value };
}

function addressComponent(components: GooglePlacesAddressComponent[] | undefined, type: string): string | null {
  const match = components?.find((c) => c.types?.includes(type));
  return match?.shortText ?? match?.longText ?? null;
}

/**
 * Mapea un Place crudo de Google a nuestro shape común de campos —
 * CONFIRMED cuando el dato viene literal de la respuesta y pasa
 * validación de formato, NOT_FOUND en cualquier otro caso. Google Places
 * no da email de contacto ni nombres de personas ni señales de
 * contratación — quedan NOT_FOUND siempre, igual que con Overpass, nunca
 * se infiere nada de la nada.
 */
export function extractFieldsFromGooglePlace(
  place: GooglePlace,
  fallbackState: string,
): { name: string | null; fields: Record<string, DiscoveredField>; providerTypes: string[] } {
  const name = place.displayName?.text ?? null;

  const websiteRaw = place.websiteUri ?? null;
  const website = websiteRaw && isValidUrl(websiteRaw) ? websiteRaw : null;

  const phone = place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null;

  const city = addressComponent(place.addressComponents, "locality");
  const state = addressComponent(place.addressComponents, "administrative_area_level_1") ?? fallbackState;
  const address = place.formattedAddress ?? null;

  return {
    name,
    fields: {
      name: name ? field("CONFIRMED", name) : field("NOT_FOUND", null),
      website: website ? field("CONFIRMED", website) : field("NOT_FOUND", null),
      phone: phone ? field("CONFIRMED", phone) : field("NOT_FOUND", null),
      email: field("NOT_FOUND", null), // Google Places no provee email de contacto
      city: city ? field("CONFIRMED", city) : field("NOT_FOUND", null),
      state: state ? field("CONFIRMED", state) : field("NOT_FOUND", null),
      address: address ? field("CONFIRMED", address) : field("NOT_FOUND", null),
      hiringSignals: field("NOT_FOUND", null),
      visiblePositions: field("NOT_FOUND", null),
      contactName: field("NOT_FOUND", null),
    },
    // F16: categorías reales que Google le asigna a este negocio (ej.
    // "electrician", "general_contractor") -- evidencia de negocio de
    // primera mano, nunca derivada de nuestro texto de búsqueda. Ver
    // business-validation.ts.
    providerTypes: place.types ?? [],
  };
}

async function fetchGooglePlacesTextSearch(
  taskId: string,
  apiKey: string,
  textQuery: string,
  maxResultCount: number,
  abortSignal: AbortSignal | undefined,
): Promise<{ places: GooglePlace[] } | { error: string; cancelled?: boolean }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (isCancellation(abortSignal)) {
      log(taskId, "provider request cancelled", { textQuery, attempt });
      return { error: "cancelled by user", cancelled: true };
    }

    log(taskId, "provider requested", { provider: "Google Places", textQuery, attempt, maxAttempts: MAX_RETRIES });

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    try {
      const res = await fetch(PLACES_TEXT_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({ textQuery, maxResultCount, languageCode: "en" }),
        signal,
      });

      log(taskId, "provider response", { textQuery, attempt, status: res.status, ok: res.ok });

      if (!res.ok) {
        // 4xx (key inválida, cuota, request mal formado) no se arregla
        // reintentando — solo reintentar en 5xx/429 real.
        if (res.status < 500 && res.status !== 429) {
          const body = await res.text().catch(() => "");
          return { error: `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}` };
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        return { error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as { places?: GooglePlace[] };
      return { places: json.places ?? [] };
    } catch (err) {
      if (abortSignal?.aborted) {
        log(taskId, "provider request cancelled mid-flight", { textQuery, attempt });
        return { error: "cancelled by user", cancelled: true };
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const errorLabel = timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : "unknown fetch error";
      log(taskId, "provider response", { textQuery, attempt, error: errorLabel });

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
        continue;
      }
      return { error: errorLabel };
    }
  }
  return { error: "exhausted retries" };
}

export async function searchGooglePlaces(params: ProviderSearchParams, apiKey: string): Promise<ProviderSearchResult> {
  // Bugfix multi-sector: una frase de búsqueda libre (queryPhrase) tiene
  // prioridad — Google Places entiende texto libre razonablemente bien,
  // no hace falta que matchee una de las 4 Industry del CRM. Sin ella,
  // sigue el mismo lookup fijo de siempre (comportamiento sin cambios).
  const phrase = params.queryPhrase?.trim() || INDUSTRY_QUERY_PHRASES[params.industryName];
  if (!phrase) {
    // Nunca se inventa una búsqueda para una industria fuera del alcance
    // definido — el orquestador cae a Overpass, que tampoco la cubre, y
    // el resultado queda honestamente vacío.
    return { candidates: [], costUsd: 0, sourcesUsed: [], patternsFailed: [`${params.industryName}: sin frase de búsqueda configurada para Google Places`], cancelled: false };
  }

  const textQuery = `${phrase} in ${params.city ? `${params.city}, ` : ""}${params.stateName}`;
  const maxResultCount = Math.min(Math.max(params.limit, 1), 20); // tope real de la API por request

  const result = await fetchGooglePlacesTextSearch(params.taskId, apiKey, textQuery, maxResultCount, params.abortSignal);

  if ("error" in result) {
    return {
      candidates: [],
      // Se cobra por request aunque la respuesta sea un error != a la key/cuota (ver arriba, esos ni se reintentan) —
      // registramos costo solo si de verdad se le pegó a la API (no en errores de validación local).
      costUsd: TEXT_SEARCH_COST_PER_REQUEST_USD,
      sourcesUsed: [],
      patternsFailed: [`${params.queryPhrase ?? params.industryName}:google_places_text_search (${result.error})`],
      cancelled: !!result.cancelled,
    };
  }

  log(params.taskId, "records found", { provider: "Google Places", textQuery, count: result.places.length });

  const candidates: ProviderCandidate[] = result.places.map((place) => {
    const { name, fields, providerTypes } = extractFieldsFromGooglePlace(place, params.stateCode);
    const sourceUrl = place.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${place.id}`;
    return { name, fields, sourceUrl, providerTypes };
  });

  return {
    candidates,
    costUsd: TEXT_SEARCH_COST_PER_REQUEST_USD,
    sourcesUsed: [`Google Places (${textQuery})`],
    patternsFailed: [],
    cancelled: false,
  };
}
