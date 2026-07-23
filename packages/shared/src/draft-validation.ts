/**
 * Puro, sin dependencias -- compartido entre apps/api (bloquea la
 * aprobación de un borrador con placeholders sin completar) y apps/web
 * (feedback inmediato en el editor de Approvals). Misma lista en los
 * dos lados, nunca duplicada con riesgo de drift.
 */

// F24 (auditoría de producción, hallazgo real): borradores generados
// antes del gate de contenido tenían firmas sin completar en español
// ("[Tu Nombre]", "[Tu Posición]", "[Nombre de la Agencia de Staffing]",
// "[Tu Información de Contacto]") que este detector, solo en inglés
// hasta ahora, nunca bloqueaba. `[a-zà-ÿ]` cubre minúsculas acentuadas
// del español (á é í ó ú ñ ü); con la flag `i` también cubre sus
// equivalentes en mayúscula.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  // [Your Name], [Your Position], [Your Contact Information], [Your Title]...
  /\[\s*your\s+[a-z][a-z ]{1,40}?\]/gi,
  // [Insert ...], [Company Name], [Recipient Name], [Sender Name], [Full Name]
  /\[\s*(insert|company name|recipient name|client name|sender name|full name)[a-z ]{0,40}?\]/gi,
  // [Tu Nombre], [Tu Posición], [Tu Cargo], [Tu Teléfono], [Tu Información de Contacto], [Tu Empresa/Agencia]...
  /\[\s*tu\s+[a-zà-ÿ][a-zà-ÿ ]{1,40}?\]/gi,
  // [Nombre de tu Agencia (de Staffing)], [Nombre de la Empresa], [Inserta/Insertar ...]
  /\[\s*(inserta|insertar|nombre de (tu|la|del) (agencia|empresa|cliente|destinatario|remitente))[a-zà-ÿ ]{0,40}?\]/gi,
];

/** Devuelve los placeholders literales encontrados (deduplicados) -- [] si no hay ninguno. */
export function findKnownPlaceholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) matches.forEach((m) => found.add(m.trim()));
  }
  return Array.from(found);
}

// Estados de ApprovalRequest desde los que se puede editar un borrador
// (destinatario/asunto/cuerpo) -- SENDING/SENT/REJECTED/EXPIRED nunca.
export const EDITABLE_APPROVAL_STATUSES = ["PENDING", "READY_TO_SEND", "FAILED"] as const;
export type EditableApprovalStatus = (typeof EDITABLE_APPROVAL_STATUSES)[number];

export function isEditableApprovalStatus(status: string): status is EditableApprovalStatus {
  return (EDITABLE_APPROVAL_STATUSES as readonly string[]).includes(status);
}

export const DEFAULT_EMAIL_SIGNATURE = `Best regards,

The DreiStaff Team
DreiStaff
sales@dreistaff.com
https://dreistaff.com`;
