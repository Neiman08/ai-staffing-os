/**
 * F8.4: Candidate Normalization and Deduplication.
 *
 * Módulo puro (sin Prisma/fetch/LLM) que mirrorea exactamente el patrón de
 * `ceo-intelligence/discovery-identity.ts` (F7.3) para el dominio de
 * Candidate: funciones de normalización + un par de interfaces
 * Input/Keys + un builder + una utilidad de dedup en batch.
 *
 * `normalizeCandidateEmail`/`normalizeCandidatePhone` se MUEVEN aquí desde
 * `talent/service.ts` (antes privadas e inline) para que un módulo puro
 * pueda ser la única fuente de verdad — `talent/service.ts` (impuro) las
 * reimporta. La dirección de dependencia correcta es impuro -> puro, nunca
 * al revés, así que estas funciones no pueden seguir viviendo en
 * `talent/service.ts`.
 *
 * El comportamiento de `normalizeCandidatePhone` se preserva EXACTO
 * (stripping de dígitos + remoción de código de país "1" cuando el número
 * tiene 11 dígitos) — a propósito distinto del `normalizePhone` de
 * `discovery-identity.ts` (que produce formato E.164 `+1XXXXXXXXXX` para
 * Companies). Son dominios distintos con formatos de entrada distintos;
 * unificarlos cambiaría el comportamiento ya aprobado de dedup de
 * Candidate (F5.2).
 */

export function normalizeCandidateEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeCandidatePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function normalizeNamePart(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CandidateIdentityInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  state?: string | null;
}

export interface CandidateIdentityKeys {
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  /**
   * Clave NUEVA en F8.4 (no existía antes): nombre + apellido + estado.
   * A diferencia de `normalizedNameCityState` en discovery-identity.ts, no
   * es una red de seguridad final (nunca null) sino un criterio adicional
   * OPCIONAL — dos Candidates con nombre+apellido+estado idénticos pero sin
   * state en alguno de los dos simplemente no matchean por esta clave (null),
   * evitando falsos positivos de nombres comunes sin ubicación conocida.
   */
  normalizedNameState: string | null;
}

export function buildCandidateIdentityKeys(input: CandidateIdentityInput): CandidateIdentityKeys {
  const state = input.state ? normalizeNamePart(input.state) : "";
  const firstName = normalizeNamePart(input.firstName);
  const lastName = normalizeNamePart(input.lastName);

  return {
    normalizedEmail: input.email ? normalizeCandidateEmail(input.email) : null,
    normalizedPhone: input.phone ? normalizeCandidatePhone(input.phone) : null,
    normalizedNameState: state && firstName && lastName ? `${firstName}|${lastName}|${state}` : null,
  };
}

export interface CandidateIdentityLike {
  identity: CandidateIdentityKeys;
}

export interface CandidateDeduplicationResult<T extends CandidateIdentityLike> {
  unique: T[];
  duplicates: Array<{ candidate: T; duplicateOfKey: string; matchedOn: keyof CandidateIdentityKeys }>;
}

/**
 * Deduplicación determinista en batch, para uso futuro en flujos de
 * import/sourcing masivo de Candidates (no usada todavía por
 * `createCandidate`, que mantiene su chequeo 1-a-1 contra la DB vía
 * `findDuplicateCandidate` en talent/service.ts — ver comentario ahí sobre
 * por qué no hay índice único todavía). Recorre `candidates` EN ORDEN,
 * probando cada clave en el orden fijo [normalizedEmail, normalizedPhone,
 * normalizedNameState]; la primera que matchea decide.
 */
export function deduplicateCandidates<T extends CandidateIdentityLike>(
  candidates: T[],
  existingKeys: Partial<Record<keyof CandidateIdentityKeys, Set<string>>> = {},
): CandidateDeduplicationResult<T> {
  const seen: Record<keyof CandidateIdentityKeys, Set<string>> = {
    normalizedEmail: new Set(existingKeys.normalizedEmail ?? []),
    normalizedPhone: new Set(existingKeys.normalizedPhone ?? []),
    normalizedNameState: new Set(existingKeys.normalizedNameState ?? []),
  };
  const ORDER: Array<keyof CandidateIdentityKeys> = ["normalizedEmail", "normalizedPhone", "normalizedNameState"];

  const unique: T[] = [];
  const duplicates: CandidateDeduplicationResult<T>["duplicates"] = [];

  for (const candidate of candidates) {
    let matchedOn: keyof CandidateIdentityKeys | null = null;
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
