import { isPhoneContaminated } from "./contact-channel";

/**
 * F34 (auditoría arquitectónica transversal, hallazgo real: 7.3% de
 * bounce rate real, ningún hard bounce marcado como inválido permanente
 * -- Contact.bouncedAt nunca se escribía en ningún lugar del código --
 * y la lógica de "¿este email puede usarse?" estaba duplicada y
 * parcialmente distinta en al menos 3 lugares (draft.executor.ts
 * filtraba doNotContact/bouncedAt/unsubscribedAt SOLO ahí;
 * approval-quality-gate.ts chequeaba sintaxis + contaminación de
 * teléfono, pero nada de bounces; contact-channel.ts/pickBestEmail solo
 * chequeaba contaminación de teléfono): ÚNICO chokepoint compartido y
 * NO evitable para decidir si un email puede avanzar a Draft/Approval/
 * envío. Puro y determinista, sin Prisma/fetch/LLM -- el llamador
 * resuelve el estado real (Contact/CompanyContactPoint) y se lo pasa
 * acá, este módulo nunca conoce Prisma.
 *
 * Invariante estructural (pedida explícitamente): NINGÚN otro módulo
 * debe reimplementar estos chequeos por su cuenta -- approval-quality-gate.ts,
 * draft-creation-gate.ts y cualquier código de envío real deben llamar a
 * `evaluateEmailEligibility` en vez de duplicar la lógica.
 */

export const emailEligibilityBlockReasons = [
  "PHONE_CONTAMINATED",
  "INVALID_SYNTAX",
  "PERMANENTLY_INVALID",
  "DELIVERY_BLOCKED_NO_RETRY",
  "DO_NOT_CONTACT",
  "UNSUBSCRIBED",
] as const;
export type EmailEligibilityBlockReason = (typeof emailEligibilityBlockReasons)[number];

export interface EmailEligibilityInput {
  email: string | null;
  // F34: estado real ya persistido para esta dirección/Contact --
  // resuelto por el llamador (Contact.permanentlyInvalidAt/
  // CompanyContactPoint.permanentlyInvalidAt, ver migración F34).
  // Presencia = hard bounce confirmado alguna vez -- INVARIANTE: nunca
  // se limpia automáticamente, solo una acción humana explícita podría
  // hacerlo (fuera del alcance de este gate).
  permanentlyInvalidAt?: string | Date | null;
  // Última clasificación de bounce observada para esta dirección (ver
  // bounce-classification.ts) -- null si nunca rebotó.
  lastBounceClassification?: "HARD_BOUNCE" | "DELIVERY_BLOCKED" | "RETRYABLE" | "DOMAIN_ISSUE" | "UNKNOWN" | null;
  lastBounceAt?: string | Date | null;
  doNotContact?: boolean;
  unsubscribedAt?: string | Date | null;
  // Ventana de "no reintento inmediato" para DELIVERY_BLOCKED (spam) --
  // en días. Default 30: un spam block reciente no debe reintentarse a
  // los pocos días (la reputación no cambió), pero tampoco se bloquea
  // para siempre (a diferencia de HARD_BOUNCE) -- pasado el período, una
  // nueva campaña/contenido distinto puede intentarse de nuevo.
  now?: string | Date;
}

export interface EmailEligibilityResult {
  eligible: boolean;
  blockReason: EmailEligibilityBlockReason | null;
  reason: string;
}

const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_BLOCKED_RETRY_WINDOW_DAYS = 30;

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Único chokepoint real para "¿este email puede avanzar a Draft/
 * Approval/envío?" -- evalúa TODAS las causas de bloqueo pedidas
 * explícitamente por la auditoría, en orden de severidad (estructural
 * primero, temporal al final). Nunca hace red/DB -- el llamador ya
 * resolvió el estado real.
 */
export function evaluateEmailEligibility(input: EmailEligibilityInput): EmailEligibilityResult {
  if (!input.email || !input.email.trim()) {
    return { eligible: false, blockReason: "INVALID_SYNTAX", reason: "Sin dirección de email." };
  }

  if (!EMAIL_SYNTAX_RE.test(input.email)) {
    return { eligible: false, blockReason: "INVALID_SYNTAX", reason: `"${input.email}" no tiene sintaxis de email válida.` };
  }

  if (isPhoneContaminated(input.email)) {
    return {
      eligible: false,
      blockReason: "PHONE_CONTAMINATED",
      reason: `"${input.email}" parece contaminado con una secuencia telefónica -- nunca elegible, sin importar el resto de la evidencia.`,
    };
  }

  if (input.doNotContact) {
    return { eligible: false, blockReason: "DO_NOT_CONTACT", reason: "El contacto está marcado explícitamente como 'no contactar'." };
  }

  if (input.unsubscribedAt) {
    return { eligible: false, blockReason: "UNSUBSCRIBED", reason: `El contacto se dio de baja el ${new Date(input.unsubscribedAt).toISOString().slice(0, 10)} -- nunca elegible de nuevo automáticamente.` };
  }

  // F34: invariante explícita -- "los hard bounces deben marcar el email
  // como inválido permanentemente". Nunca hay ventana de tiempo ni
  // reintento para esto, a diferencia de DELIVERY_BLOCKED.
  if (input.permanentlyInvalidAt) {
    return {
      eligible: false,
      blockReason: "PERMANENTLY_INVALID",
      reason: `Marcado inválido permanentemente el ${new Date(input.permanentlyInvalidAt).toISOString().slice(0, 10)} (hard bounce confirmado) -- nunca reintentable automáticamente.`,
    };
  }

  // F34: invariante explícita -- "los spam blocks deben marcarse como
  // DELIVERY_BLOCKED, no como email inválido" -- nunca se marca
  // permanentemente inválido, pero sí se respeta una ventana real de no
  // reintento inmediato.
  if (input.lastBounceClassification === "DELIVERY_BLOCKED" && input.lastBounceAt) {
    const now = input.now ? new Date(input.now) : new Date();
    const ageDays = daysBetween(now, new Date(input.lastBounceAt));
    if (ageDays < DELIVERY_BLOCKED_RETRY_WINDOW_DAYS) {
      return {
        eligible: false,
        blockReason: "DELIVERY_BLOCKED_NO_RETRY",
        reason: `Bloqueado por política/spam hace ${ageDays.toFixed(0)} día(s) -- la política prohíbe reintento inmediato (ventana: ${DELIVERY_BLOCKED_RETRY_WINDOW_DAYS} días).`,
      };
    }
  }

  return { eligible: true, blockReason: null, reason: "Elegible -- sin contaminación, sintaxis válida, sin bloqueos de bounce/opt-out registrados." };
}
