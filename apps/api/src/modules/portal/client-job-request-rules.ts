/**
 * F10.3: Client Job Request -- puro, determinista, sin Prisma/fetch/
 * LLM. Solo el grafo de transiciones -- NUNCA convierte automáticamente
 * una solicitud en JobOrder real, NUNCA infiere categoryId/payRate/
 * billRate. Esas decisiones viven en el wiring (`service.ts`), siempre
 * como una acción humana explícita.
 */

export const CLIENT_JOB_REQUEST_RULES_VERSION = 1;

export type ClientJobRequestStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "NEEDS_INFORMATION"
  | "APPROVED"
  | "CONVERTED_TO_JOB_ORDER"
  | "REJECTED"
  | "CANCELLED";

/**
 * DRAFT -> SUBMITTED (por el cliente) -> UNDER_REVIEW (recepción
 * interna) -> NEEDS_INFORMATION/APPROVED/REJECTED (decisión interna).
 * NEEDS_INFORMATION vuelve a SUBMITTED cuando el cliente completa la
 * información pedida (nunca directo a UNDER_REVIEW -- el ciclo de
 * revisión se repite desde el mismo punto de entrada). APPROVED solo
 * avanza a CONVERTED_TO_JOB_ORDER (acción explícita, nunca automática).
 * CANCELLED es alcanzable desde cualquier estado no terminal -- el
 * cliente puede retirar su solicitud en cualquier momento salvo que ya
 * se haya decidido (APPROVED/CONVERTED_TO_JOB_ORDER/REJECTED).
 * CONVERTED_TO_JOB_ORDER/REJECTED/CANCELLED son terminales.
 */
export const CLIENT_JOB_REQUEST_TRANSITIONS: Record<ClientJobRequestStatus, ClientJobRequestStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["NEEDS_INFORMATION", "APPROVED", "REJECTED", "CANCELLED"],
  NEEDS_INFORMATION: ["SUBMITTED", "CANCELLED"],
  APPROVED: ["CONVERTED_TO_JOB_ORDER"],
  CONVERTED_TO_JOB_ORDER: [],
  REJECTED: [],
  CANCELLED: [],
};

export function isValidClientJobRequestTransition(from: ClientJobRequestStatus, to: ClientJobRequestStatus): boolean {
  if (from === to) return true;
  return CLIENT_JOB_REQUEST_TRANSITIONS[from].includes(to);
}

/** Estados en los que el cliente todavía puede editar los campos de la solicitud (nunca una vez enviada a revisión). */
export const CLIENT_EDITABLE_STATUSES = new Set<ClientJobRequestStatus>(["DRAFT", "NEEDS_INFORMATION"]);

/** Estados que un rol interno puede alcanzar mediante revisión (nunca DRAFT/SUBMITTED -- esos son del cliente). */
export const INTERNAL_REVIEW_STATUSES = new Set<ClientJobRequestStatus>(["UNDER_REVIEW", "NEEDS_INFORMATION", "APPROVED", "REJECTED"]);
