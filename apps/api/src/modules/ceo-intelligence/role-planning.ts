/**
 * F7.6: Decision-Maker Role Planning -- puro, determinista, sin Prisma/
 * fetch/LLM. Decide QUÉ roles buscar para una Company, nunca inventa
 * personas (eso es Contact Intelligence, F7.7, fuera de alcance acá).
 * Fuentes de evidencia, en orden de prioridad: (1) StructuredIntent.
 * decisionRoles -- roles que el usuario pidió EXPLÍCITAMENTE en la
 * instrucción; (2) BusinessTaxonomyEntry.decisionMakers -- roles típicos
 * de decisión para ese tipo de negocio (F7.1, ya declarados); (3) señal
 * de contratación (F7.5) -- si la empresa está confirmada/probablemente
 * contratando, se prioriza a quien maneja esa contratación (HR/
 * Recruiting/Talent Acquisition) sobre otros roles genéricos.
 */

export const ROLE_PLANNING_VERSION = 1;

export interface RolePlanEntry {
  role: string;
  // 1 = máxima prioridad. Nunca hay empates silenciosos -- el orden de
  // construcción (intent > taxonomía > boost de hiring signal) decide.
  priority: number;
  rationale: string;
  source: "intent" | "taxonomy" | "hiring_signal_boost";
}

export interface DecisionRolePlan {
  companyId: string;
  targetRoles: RolePlanEntry[];
  excludedRoles: string[];
  confidence: number;
  taxonomySource: string;
  hiringSignalSource: string | null;
  planVersion: number;
}

export interface RolePlanInput {
  companyId: string;
  taxonomyKey: string;
  // StructuredIntent.decisionRoles (F7.1) -- roles que el usuario pidió
  // explícitamente ("Encuentra HR Manager o Plant Manager").
  intentDecisionRoles: string[];
  // BusinessTaxonomyEntry.decisionMakers de taxonomyKey.
  taxonomyDecisionMakers: string[];
  // HiringSignalResult.hiringStatus (F7.5) -- null si ese paso no corrió.
  hiringStatus: string | null;
  // Términos de exclusión de la misión -- un rol nunca se planifica si
  // coincide con una exclusión explícita.
  missionExclusions: string[];
}

// Roles que típicamente manejan una contratación activa -- se priorizan
// cuando hay evidencia real de que la empresa está contratando (F7.5).
const HIRING_RELATED_ROLE_KEYWORDS = ["hr", "human resources", "recruit", "talent acquisition", "people"];

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function isExcluded(role: string, exclusions: string[]): boolean {
  const normalizedRole = normalize(role);
  return exclusions.some((ex) => ex.trim() && normalizedRole.includes(normalize(ex)));
}

function isHiringRelatedRole(role: string): boolean {
  const normalizedRole = normalize(role);
  return HIRING_RELATED_ROLE_KEYWORDS.some((k) => normalizedRole.includes(k));
}

/**
 * Construye el plan de roles de decisión para una Company ya validada
 * (F7.4) y opcionalmente ya evaluada por Hiring Signal Intelligence
 * (F7.5). Determinista: mismo input siempre produce el mismo resultado.
 * Nunca crea un Contact ni una persona -- solo declara QUÉ buscar.
 */
export function buildDecisionRolePlan(input: RolePlanInput): DecisionRolePlan {
  const excludedRoles: string[] = [];
  const seen = new Set<string>();
  const entries: RolePlanEntry[] = [];
  let priority = 1;

  // 1) Roles explícitamente pedidos por el usuario -- máxima prioridad.
  for (const role of input.intentDecisionRoles) {
    const key = normalize(role);
    if (!role.trim() || seen.has(key)) continue;
    if (isExcluded(role, input.missionExclusions)) {
      excludedRoles.push(role);
      continue;
    }
    seen.add(key);
    entries.push({ role, priority: priority++, rationale: "Pedido explícitamente en la instrucción del usuario.", source: "intent" });
  }

  // 2) Roles típicos de la taxonomía -- default razonable cuando el
  // usuario no especificó ninguno, o complemento cuando sí lo hizo.
  for (const role of input.taxonomyDecisionMakers) {
    const key = normalize(role);
    if (!role.trim() || seen.has(key)) continue;
    if (isExcluded(role, input.missionExclusions)) {
      excludedRoles.push(role);
      continue;
    }
    seen.add(key);
    entries.push({
      role,
      priority: priority++,
      rationale: `Rol de decisión típico para esta categoría de negocio (taxonomía "${input.taxonomyKey}").`,
      source: "taxonomy",
    });
  }

  // 3) Boost de hiring signal -- si hay evidencia real de contratación
  // activa, los roles relacionados con RR.HH./reclutamiento suben al
  // frente (sin duplicar la entrada, solo reordenando su prioridad).
  const hiringConfirmed = input.hiringStatus === "CONFIRMED_HIRING" || input.hiringStatus === "LIKELY_HIRING";
  if (hiringConfirmed) {
    const hiringRelated = entries.filter((e) => isHiringRelatedRole(e.role));
    const others = entries.filter((e) => !isHiringRelatedRole(e.role));
    let reordered = 1;
    for (const e of hiringRelated) {
      e.priority = reordered++;
      e.source = "hiring_signal_boost";
      e.rationale = `${e.rationale} Priorizado: la empresa muestra evidencia real de contratación activa (${input.hiringStatus}).`;
    }
    for (const e of others) e.priority = reordered++;
    entries.length = 0;
    entries.push(...hiringRelated, ...others);
  }

  let confidence = input.intentDecisionRoles.length > 0 ? 0.9 : entries.length > 0 ? 0.6 : 0.2;
  if (hiringConfirmed) confidence = Math.min(1, confidence + 0.1);

  return {
    companyId: input.companyId,
    targetRoles: entries,
    excludedRoles,
    confidence,
    taxonomySource: input.taxonomyKey,
    hiringSignalSource: input.hiringStatus,
    planVersion: ROLE_PLANNING_VERSION,
  };
}
