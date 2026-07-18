/**
 * F9.10: Exceptions and Incidents -- puro, determinista, sin Prisma/
 * fetch/LLM. Solo el grafo de transiciones de estado -- NUNCA infiere
 * culpa, NUNCA decide una sanción, NUNCA determina que un Worker/
 * Assignment debe terminarse. Esas son siempre decisiones humanas
 * tomadas por separado con los endpoints ya existentes de F9.5/F5.3.
 */

export const INCIDENT_RULES_VERSION = 1;

export type IncidentStatusValue = "OPEN" | "UNDER_REVIEW" | "ACTION_REQUIRED" | "RESOLVED" | "CLOSED";

/**
 * OPEN -> UNDER_REVIEW -> ACTION_REQUIRED -> RESOLVED -> CLOSED, con
 * reapertura permitida en cada paso intermedio (revisar de nuevo un
 * incidente ya "resuelto" es una realidad operativa común, no un error).
 * CLOSED es terminal -- reabrir un incidente cerrado exige crear uno
 * nuevo referenciando el anterior en la descripción, decisión
 * conservadora que evita un ciclo de reapertura indefinido.
 */
export const INCIDENT_STATUS_TRANSITIONS: Record<IncidentStatusValue, IncidentStatusValue[]> = {
  OPEN: ["UNDER_REVIEW", "RESOLVED"],
  UNDER_REVIEW: ["ACTION_REQUIRED", "RESOLVED", "OPEN"],
  ACTION_REQUIRED: ["RESOLVED", "UNDER_REVIEW"],
  RESOLVED: ["CLOSED", "UNDER_REVIEW"],
  CLOSED: [],
};

export function isValidIncidentStatusTransition(from: IncidentStatusValue, to: IncidentStatusValue): boolean {
  if (from === to) return true;
  return INCIDENT_STATUS_TRANSITIONS[from].includes(to);
}

export type IncidentTypeValue =
  | "NO_SHOW"
  | "LATE_ARRIVAL"
  | "EARLY_DEPARTURE"
  | "ATTENDANCE"
  | "SAFETY"
  | "CLIENT_COMPLAINT"
  | "WORKER_COMPLAINT"
  | "TIME_DISCREPANCY"
  | "DOCUMENT_ISSUE"
  | "COMPLIANCE_ISSUE"
  | "OTHER";

/**
 * Validación mínima de negocio: exige al menos UNA relación (Worker/
 * Assignment/Company/JobOrder) para todo tipo salvo OTHER -- un
 * NO_SHOW o SAFETY sin ningún contexto no es accionable. Nunca valida
 * de más (no exige, por ejemplo, que TIME_DISCREPANCY tenga que
 * apuntar a una TimeEntry real -- eso viviría en otra fase si se pide).
 */
export function requiresAtLeastOneRelation(type: IncidentTypeValue): boolean {
  return type !== "OTHER";
}
