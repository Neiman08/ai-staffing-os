import { normalizeText } from "./text-normalize";

/**
 * F7.3: funciones puras de identidad/dedup para el nuevo ejecutor de
 * descubrimiento (mission-executor.ts, fuera de este archivo). Cero
 * Prisma, cero fetch — igual que el resto de ceo-intelligence/. La
 * lógica de normalización de nombre/teléfono replica DELIBERADAMENTE la
 * ya escrita y probada en packages/db/scripts/illinois-backfill-lib.mjs
 * (normalizedNameKey/normalizePhone/canonicalDomain) en vez de inventar
 * una nueva — mismo criterio, ver
 * docs/F7_CEO_INTELLIGENCE_AND_AUTONOMOUS_CLIENT_ACQUISITION_PLAN.md §F7.3.
 */

const CORPORATE_SUFFIX_RE = /\b(llc|inc|corp|corporation|co|company|ltd)\b/g;

/** Minúsculas + sin acentos + sin puntuación + sin sufijo corporativo + espacios colapsados. */
export function normalizeCompanyName(rawName: string | null | undefined): string {
  if (!rawName) return "";
  return normalizeText(rawName)
    .replace(/[.,]/g, "")
    .replace(CORPORATE_SUFFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dominio canónico (host sin "www.", minúsculas) — null si no es una URL válida. */
export function normalizeDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

/** E.164 simplificado (+1XXXXXXXXXX) — null si no son 10 u 11 dígitos (con "1" inicial) válidos. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Extrae el providerPlaceId del sourceUrl devuelto por Google Places
 * (discovery-providers/google-places.ts, sin modificar) — SOLO funciona
 * cuando ese archivo usó su propio formato de respaldo
 * (`.../maps/place/?q=place_id:{id}`), que es lo que emite cuando
 * `place.googleMapsUri` no vino en la respuesta de la API. Cuando SÍ vino
 * `googleMapsUri` (una URL real de Google Maps, formato no garantizado),
 * esta función honestamente devuelve null — limitación documentada, no
 * se parte el archivo del proveedor (que no se toca en esta fase) para
 * garantizar un id extraíble en todos los casos.
 */
export function extractProviderPlaceId(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const match = /place_id:([^&\s]+)/.exec(sourceUrl);
  return match?.[1] ?? null;
}

export interface CompanyIdentityInput {
  name: string | null | undefined;
  website: string | null | undefined;
  phone: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
  sourceUrl: string | null | undefined;
}

export interface CompanyIdentityKeys {
  providerPlaceId: string | null;
  canonicalDomain: string | null;
  normalizedPhone: string | null;
  // "nombre|ciudad|estado" — siempre presente (nunca null), última línea
  // de defensa del dedup cuando ninguna de las otras 3 claves aplica.
  normalizedNameCityState: string;
}

/**
 * Las 4 claves de identidad, en el orden exacto exigido por el plan
 * (providerPlaceId > canonicalDomain > normalizedPhone >
 * normalizedNameCityState) — deduplicateDiscoveryCandidates las consume
 * en ese mismo orden, nunca decide el orden por su cuenta.
 */
export function buildCompanyIdentityKeys(input: CompanyIdentityInput): CompanyIdentityKeys {
  const normalizedName = normalizeCompanyName(input.name);
  const city = (input.city ?? "").toLowerCase().trim();
  const state = (input.state ?? "").toLowerCase().trim();
  return {
    providerPlaceId: extractProviderPlaceId(input.sourceUrl),
    canonicalDomain: normalizeDomain(input.website),
    normalizedPhone: normalizePhone(input.phone),
    normalizedNameCityState: `${normalizedName}|${city}|${state}`,
  };
}

export interface DiscoveryCandidateLike {
  identity: CompanyIdentityKeys;
}

export interface DeduplicationResult<T extends DiscoveryCandidateLike> {
  unique: T[];
  duplicates: Array<{ candidate: T; duplicateOfKey: string; matchedOn: keyof CompanyIdentityKeys }>;
}

/**
 * Deduplicación global determinista: recorre `candidates` EN ORDEN,
 * quedándose con la primera aparición de cada clave de identidad y
 * marcando cualquier repetición posterior (misma query, distinta query,
 * o ya vista en `existingKeys` — ej. Companies reales ya en el CRM) como
 * duplicado. Se prueba cada una de las 4 claves en el orden fijo del
 * plan; la primera que matchea decide — nunca se combinan/pesan entre
 * sí. `normalizedNameCityState` nunca es null, así que dos candidatos sin
 * ningún otro dato en común pero con nombre+ciudad+estado idénticos
 * igual se consideran el mismo — la red de seguridad final.
 */
export function deduplicateDiscoveryCandidates<T extends DiscoveryCandidateLike>(
  candidates: T[],
  existingKeys: Partial<Record<keyof CompanyIdentityKeys, Set<string>>> = {},
): DeduplicationResult<T> {
  const seen: Record<keyof CompanyIdentityKeys, Set<string>> = {
    providerPlaceId: new Set(existingKeys.providerPlaceId ?? []),
    canonicalDomain: new Set(existingKeys.canonicalDomain ?? []),
    normalizedPhone: new Set(existingKeys.normalizedPhone ?? []),
    normalizedNameCityState: new Set(existingKeys.normalizedNameCityState ?? []),
  };
  const ORDER: Array<keyof CompanyIdentityKeys> = [
    "providerPlaceId",
    "canonicalDomain",
    "normalizedPhone",
    "normalizedNameCityState",
  ];

  const unique: T[] = [];
  const duplicates: DeduplicationResult<T>["duplicates"] = [];

  for (const candidate of candidates) {
    let matchedOn: keyof CompanyIdentityKeys | null = null;
    let duplicateOfKey = "";
    for (const field of ORDER) {
      const value = candidate.identity[field];
      if (!value) continue;
      if (seen[field].has(value)) {
        matchedOn = field;
        duplicateOfKey = value;
        break;
      }
    }

    if (matchedOn) {
      duplicates.push({ candidate, duplicateOfKey, matchedOn });
      continue;
    }

    for (const field of ORDER) {
      const value = candidate.identity[field];
      if (value) seen[field].add(value);
    }
    unique.push(candidate);
  }

  return { unique, duplicates };
}
