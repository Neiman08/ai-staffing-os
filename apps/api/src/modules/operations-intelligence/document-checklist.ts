/**
 * F9.2: Document Checklist -- puro, determinista, sin Prisma/fetch/LLM.
 * Genera y valida el ciclo de vida de una lista de documentos
 * requeridos para UN `WorkerOnboarding` (F9.1) -- reutiliza
 * `DocumentType` (catálogo ya existente, F0/F5) como fuente de verdad
 * de QUÉ documentos existen; nunca inventa un tipo de documento nuevo.
 * Un `DocumentChecklistItem` es un registro de SEGUIMIENTO (estado de
 * checklist, quién verificó, cuándo vence) -- el archivo real, si
 * existe, sigue viviendo en `Document` (F0/F5), enlazado opcionalmente
 * vía `documentId`. Nunca se guardan SSN/imágenes/PII innecesaria acá
 * -- solo metadata (`label`, `status`, fechas, referencias por id).
 */

export const DOCUMENT_CHECKLIST_VERSION = 1;

export type ChecklistItemStatus =
  | "NOT_REQUESTED"
  | "PENDING"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "VERIFIED"
  | "REJECTED"
  | "EXPIRED"
  | "WAIVED";

/**
 * Grafo de transiciones -- mismo criterio que el resto del proyecto.
 * `WAIVED` siempre puede reabrirse a `NOT_REQUESTED` (una excepción no
 * es permanente); `REJECTED`/`EXPIRED` siempre pueden reintentarse
 * volviendo a `PENDING` (nunca un callejón sin salida para el
 * candidato/worker).
 */
export const CHECKLIST_ITEM_TRANSITIONS: Record<ChecklistItemStatus, ChecklistItemStatus[]> = {
  NOT_REQUESTED: ["PENDING", "WAIVED"],
  PENDING: ["SUBMITTED", "WAIVED"],
  SUBMITTED: ["UNDER_REVIEW", "PENDING"],
  UNDER_REVIEW: ["VERIFIED", "REJECTED", "WAIVED"],
  VERIFIED: ["EXPIRED", "WAIVED"],
  REJECTED: ["PENDING", "WAIVED"],
  EXPIRED: ["PENDING", "WAIVED"],
  WAIVED: ["NOT_REQUESTED"],
};

export function isValidChecklistItemTransition(from: ChecklistItemStatus, to: ChecklistItemStatus): boolean {
  if (from === to) return true;
  return CHECKLIST_ITEM_TRANSITIONS[from].includes(to);
}

export interface RequiredDocumentTypeInput {
  documentTypeId: string;
  documentTypeKey: string;
  documentTypeName: string;
}

export interface ChecklistItemDraft {
  documentTypeId: string;
  label: string;
  required: true;
  status: "PENDING";
  manualReviewRequired: boolean;
}

/**
 * Construye el checklist inicial a partir de los tipos de documento
 * REALMENTE requeridos por el Job Order (`JobOrder.requirements`, ya
 * existente -- nunca una lista inventada). Determinista: mismo input,
 * mismo orden de salida. `manualReviewRequired` es `true` para
 * cualquier documento cuyo `DocumentType.requiresExpiration` sea
 * verdadero -- un documento con vencimiento siempre amerita una
 * revisión humana antes de marcarse VERIFIED, nunca una verificación
 * automática silenciosa.
 */
export function buildChecklistFromRequirements(
  requiredTypes: RequiredDocumentTypeInput[],
  requiresExpirationByTypeId: Record<string, boolean>,
): ChecklistItemDraft[] {
  return requiredTypes.map((t) => ({
    documentTypeId: t.documentTypeId,
    label: t.documentTypeName,
    required: true,
    status: "PENDING",
    manualReviewRequired: requiresExpirationByTypeId[t.documentTypeId] ?? false,
  }));
}

export interface ChecklistItemExpiryInput {
  status: ChecklistItemStatus;
  expiresAt: string | Date | null;
}

/**
 * Determina si un item VERIFIED ya venció -- pura función de fecha,
 * nunca cambia el registro por sí misma (eso lo hace el wiring impuro
 * al releer/actualizar). Cualquier estado que no sea VERIFIED con una
 * fecha de vencimiento ya pasada nunca se considera "vencido" (ej. un
 * PENDING sin `expiresAt` no es un caso de expiración).
 */
export function isChecklistItemExpired(input: ChecklistItemExpiryInput, now: Date = new Date()): boolean {
  if (input.status !== "VERIFIED") return false;
  if (!input.expiresAt) return false;
  return new Date(input.expiresAt).getTime() <= now.getTime();
}

export interface ChecklistSummary {
  totalRequired: number;
  satisfied: number;
  missing: string[];
  expired: string[];
  pendingReview: string[];
  allSatisfied: boolean;
}

export interface ChecklistSummaryItemInput {
  documentTypeKey: string;
  required: boolean;
  status: ChecklistItemStatus;
}

/**
 * Resume el checklist completo -- reutilizado por F9.3 (Compliance
 * Rules) y F9.1 (progreso de onboarding) para no reimplementar el
 * mismo conteo en cada consumidor.
 */
export function summarizeChecklist(items: ChecklistSummaryItemInput[]): ChecklistSummary {
  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !["VERIFIED"].includes(i.status)).map((i) => i.documentTypeKey);
  const expired = required.filter((i) => i.status === "EXPIRED").map((i) => i.documentTypeKey);
  const pendingReview = required.filter((i) => i.status === "SUBMITTED" || i.status === "UNDER_REVIEW").map((i) => i.documentTypeKey);
  const satisfied = required.length - missing.length;

  return {
    totalRequired: required.length,
    satisfied,
    missing,
    expired,
    pendingReview,
    allSatisfied: missing.length === 0,
  };
}
