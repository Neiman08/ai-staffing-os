import { normalizeEmail, validateEmailTrust } from "./email-trust";

/**
 * F23: advertencia NO bloqueante para un humano revisando un borrador de
 * Approvals -- nunca sustituye ni inventa el destinatario, solo señala
 * cuándo conviene verificarlo antes de aprobar. Puro, sin Prisma/fetch,
 * mismo criterio que email-trust.ts (reutilizado acá, no duplicado).
 */
export interface RecipientTrustWarning {
  suspicious: boolean;
  reasons: string[];
}

// 4+ dígitos consecutivos antes de "@" -- reservas/booking-engines suelen
// generar direcciones tipo "reservations-8823041@..." o "10293847@...".
const UNUSUAL_NUMERIC_LOCALPART_RE = /\d{4,}/;

const RESERVATION_KEYWORDS = ["reservation", "reservations", "booking", "bookings", "frontdesk", "reception", "concierge"];

function localPartTokens(localPart: string): string[] {
  return localPart.split(/[._+-]+/).filter(Boolean);
}

function looksLikeReservationInbox(localPart: string): boolean {
  const tokens = localPartTokens(localPart);
  return tokens.some((token) => RESERVATION_KEYWORDS.some((kw) => token === kw || (kw.length >= 4 && token.startsWith(kw))));
}

export function assessRecipientTrust(rawEmail: string, companyWebsite: string | null): RecipientTrustWarning {
  const normalized = normalizeEmail(rawEmail);
  if (!normalized.valid || !normalized.value) {
    // La sintaxis inválida ya la bloquea el endpoint de edición al
    // guardar -- acá solo se advierte, nunca se repite ese bloqueo.
    return { suspicious: false, reasons: [] };
  }

  const reasons: string[] = [];
  const localPart = normalized.value.split("@")[0] ?? "";

  if (UNUSUAL_NUMERIC_LOCALPART_RE.test(localPart)) {
    reasons.push('El destinatario contiene una cadena numérica inusual antes de "@" -- verifica que sea un contacto real antes de aprobar.');
  }
  if (looksLikeReservationInbox(localPart)) {
    reasons.push("Parece un email de reservas/recepción, no un contacto comercial -- verifica antes de aprobar.");
  }

  const trust = validateEmailTrust({ rawEmail, companyWebsite });
  if (trust.status === "INVALID") {
    reasons.push(`El dominio "${trust.domain ?? ""}" no coincide con el sitio oficial de la empresa -- verifica el destinatario antes de aprobar.`);
  } else if (trust.status === "RISKY") {
    reasons.push("Email marcado como riesgoso (proveedor gratuito/personal o catch-all sin verificar) -- verifica antes de aprobar.");
  } else if (trust.status === "UNKNOWN" && companyWebsite === null) {
    reasons.push("No se pudo verificar el dominio de este email (la empresa no tiene sitio conocido) -- verifica antes de aprobar.");
  }

  return { suspicious: reasons.length > 0, reasons };
}
