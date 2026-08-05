/**
 * F34 (auditoría arquitectónica transversal, hallazgo real: 6 de 82
 * envíos reales rebotaron (7.3%), y el sistema los guardaba TODOS bajo
 * un único status BOUNCED genérico, sin distinguir un hard bounce
 * permanente de un spam block o de un problema transitorio -- ninguno
 * de los 6 llegó a marcar Contact.bouncedAt (campo nunca escrito en
 * ningún lugar del código, confirmado por búsqueda exhaustiva), así que
 * la misma dirección podía volver a recibir outreach real en el futuro.
 *
 * Puro y determinista, sin Prisma/fetch/LLM (mismo criterio que el resto
 * de ceo-intelligence/) -- clasifica el texto real de un NDR (Non-
 * Delivery Report) o el código HTTP de un intento de envío en una de las
 * categorías reales que importan para decidir si un email puede volver
 * a intentarse:
 *
 *   - HARD_BOUNCE: evidencia real de que la dirección NO EXISTE (5.1.1
 *     user unknown, 5.1.10, "no such user", "mailbox not found") o de
 *     rechazo permanente del destinatario (5.4.1 recipient rejected, sin
 *     evidencia de que sea una política de spam) -- NUNCA reintentable,
 *     marca el email como inválido para siempre.
 *   - DELIVERY_BLOCKED: evidencia real de bloqueo por política/spam
 *     (5.7.x, "spam", "policy", "blocked", "reputation") -- el email
 *     puede existir, el problema es de contenido/reputación de envío,
 *     nunca se reintenta automáticamente sin una revisión humana.
 *   - RETRYABLE: evidencia real de un problema TRANSITORIO (4.x, buzón
 *     lleno "mailbox full"/"quota exceeded", timeout, greylisting) --
 *     puede reintentarse más adelante, nunca se marca como inválido.
 *   - DOMAIN_ISSUE: evidencia real de un problema de ENRUTAMIENTO/DNS
 *     del lado del dominio destino (mail loop, "hop count exceeded",
 *     "too many hops", DNS/MX) -- no es ni la dirección ni el contenido,
 *     es infraestructura del destino.
 *   - UNKNOWN: sin evidencia suficiente para clasificar -- nunca se
 *     inventa una categoría sin evidencia textual real.
 */

export const bounceClassifications = ["HARD_BOUNCE", "DELIVERY_BLOCKED", "RETRYABLE", "DOMAIN_ISSUE", "UNKNOWN"] as const;
export type BounceClassification = (typeof bounceClassifications)[number];

export interface BounceEvidence {
  ndrDetail: string | null;
  normalizedError?: string | null;
  httpStatusCode?: number | null;
}

export interface BounceClassificationResult {
  classification: BounceClassification;
  reason: string;
  // true SOLO para HARD_BOUNCE -- invariante explícita pedida por la
  // auditoría: "los hard bounces deben marcar el email como inválido
  // permanentemente", nunca un DELIVERY_BLOCKED/RETRYABLE/DOMAIN_ISSUE.
  isPermanentlyInvalid: boolean;
  // true para DELIVERY_BLOCKED/RETRYABLE/DOMAIN_ISSUE -- nunca para
  // HARD_BOUNCE (nunca reintentable) ni UNKNOWN (sin evidencia real para
  // decidir, se trata como no-reintentable por precaución hasta que haya
  // evidencia real).
  allowsFutureRetry: boolean;
  matchedCode: string | null;
}

// Código de estado extendido SMTP real (RFC 3463), ej. "5.1.1", "4.2.2".
const ENHANCED_STATUS_CODE_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

// Frases reales (inglés) que aparecen en NDRs reales cuando el servidor
// destino no incluye (o el proveedor de correo del remitente no expone)
// el código de estado extendido -- vocabulario cerrado de evidencia
// textual real, nunca una heurística de similitud difusa.
const HARD_BOUNCE_PHRASES = ["user unknown", "no such user", "mailbox not found", "address not found", "recipient not found", "invalid recipient", "unknown recipient", "does not exist", "wasn't found at"];
const DELIVERY_BLOCKED_PHRASES = ["spam", "reputation", "blocked", "policy", "blacklist", "denied by policy", "suspects your message is spam"];
const RETRYABLE_PHRASES = ["mailbox full", "quota exceeded", "over quota", "try again later", "temporarily deferred", "greylist", "greylisted", "throttl"];
const DOMAIN_ISSUE_PHRASES = ["hop count exceeded", "too many hops", "mail loop", "routing loop", "possible mail loop"];

function textContainsAny(text: string, phrases: string[]): string | null {
  const lower = text.toLowerCase();
  return phrases.find((phrase) => lower.includes(phrase)) ?? null;
}

/**
 * Clasifica un código de estado extendido SMTP real (RFC 3463) --
 * primera clase X (2=éxito, nunca debería llegar acá; 4=transitorio;
 * 5=permanente) combinada con la subclase real más común. Nunca asume
 * "5.x.x siempre es HARD_BOUNCE" -- 5.7.x (policy/spam) es DELIVERY_BLOCKED
 * pese a ser clase 5, porque la dirección en sí puede ser válida.
 */
function classifyEnhancedStatusCode(code: string): BounceClassification | null {
  const match = code.match(ENHANCED_STATUS_CODE_RE);
  if (!match) return null;
  const [, cls, subject, detail] = match;
  if (cls === "5") {
    if (subject === "7") return "DELIVERY_BLOCKED"; // 5.7.x: policy/spam
    if (subject === "1" && (detail === "1" || detail === "10")) return "HARD_BOUNCE"; // 5.1.1/5.1.10: user unknown
    if (subject === "1") return "HARD_BOUNCE"; // 5.1.x: cualquier otro problema de dirección -- también permanente
    if (subject === "2" && detail === "2") return "RETRYABLE"; // 5.2.2: mailbox full (SÍ existe como clase 5 en algunos proveedores, sigue siendo transitorio real)
    if (subject === "4") return "HARD_BOUNCE"; // 5.4.1 recipient rejected: permanente salvo evidencia de política (ver DELIVERY_BLOCKED_PHRASES, evaluado antes)
    return "HARD_BOUNCE"; // 5.x.x sin subclase reconocida -- clase permanente por defecto, nunca se asume reintentable sin evidencia
  }
  if (cls === "4") {
    if (subject === "2" && detail === "2") return "RETRYABLE"; // 4.2.2: mailbox full
    return "RETRYABLE"; // 4.x.x: por definición del RFC, transitorio
  }
  return null;
}

export function classifyBounceEvidence(evidence: BounceEvidence): BounceClassificationResult {
  const text = [evidence.ndrDetail, evidence.normalizedError].filter((t): t is string => !!t && t.trim().length > 0).join(" | ");

  // F34: evidencia de política/spam SIEMPRE se evalúa PRIMERO, incluso
  // sobre un código 5.x.x -- un NDR real puede traer "5.4.1 Recipient
  // address rejected: undeliverable" (código de dirección) en el mismo
  // texto que también dice "suspects your message is spam" -- cuando
  // ambas señales coexisten, la causa real es la política de contenido/
  // reputación, no que la dirección no exista.
  if (text) {
    const blockedPhrase = textContainsAny(text, DELIVERY_BLOCKED_PHRASES);
    if (blockedPhrase) {
      return {
        classification: "DELIVERY_BLOCKED",
        reason: `Evidencia real de bloqueo por política/spam ("${blockedPhrase}") -- el email puede existir, el problema es de contenido/reputación de envío.`,
        isPermanentlyInvalid: false,
        allowsFutureRetry: true,
        matchedCode: blockedPhrase,
      };
    }

    const codeMatch = text.match(ENHANCED_STATUS_CODE_RE);
    if (codeMatch) {
      const classification = classifyEnhancedStatusCode(codeMatch[0]);
      if (classification === "HARD_BOUNCE") {
        return {
          classification,
          reason: `Código de estado extendido SMTP real "${codeMatch[0]}" -- evidencia de que la dirección no existe o fue rechazada permanentemente.`,
          isPermanentlyInvalid: true,
          allowsFutureRetry: false,
          matchedCode: codeMatch[0],
        };
      }
      if (classification === "RETRYABLE") {
        return {
          classification,
          reason: `Código de estado extendido SMTP real "${codeMatch[0]}" -- problema transitorio (buzón lleno/temporal), puede reintentarse más adelante.`,
          isPermanentlyInvalid: false,
          allowsFutureRetry: true,
          matchedCode: codeMatch[0],
        };
      }
    }

    const hardPhrase = textContainsAny(text, HARD_BOUNCE_PHRASES);
    if (hardPhrase) {
      return {
        classification: "HARD_BOUNCE",
        reason: `Evidencia textual real de dirección inexistente ("${hardPhrase}").`,
        isPermanentlyInvalid: true,
        allowsFutureRetry: false,
        matchedCode: hardPhrase,
      };
    }

    const domainPhrase = textContainsAny(text, DOMAIN_ISSUE_PHRASES);
    if (domainPhrase) {
      return {
        classification: "DOMAIN_ISSUE",
        reason: `Evidencia real de un problema de enrutamiento/DNS del lado del dominio destino ("${domainPhrase}") -- no es la dirección ni el contenido.`,
        isPermanentlyInvalid: false,
        allowsFutureRetry: true,
        matchedCode: domainPhrase,
      };
    }

    const retryablePhrase = textContainsAny(text, RETRYABLE_PHRASES);
    if (retryablePhrase) {
      return {
        classification: "RETRYABLE",
        reason: `Evidencia real de un problema transitorio ("${retryablePhrase}").`,
        isPermanentlyInvalid: false,
        allowsFutureRetry: true,
        matchedCode: retryablePhrase,
      };
    }
  }

  if (evidence.httpStatusCode != null) {
    if (evidence.httpStatusCode >= 500) {
      return {
        classification: "HARD_BOUNCE",
        reason: `HTTP ${evidence.httpStatusCode} del proveedor de envío -- sin evidencia textual adicional, se trata como rechazo permanente por precaución.`,
        isPermanentlyInvalid: true,
        allowsFutureRetry: false,
        matchedCode: String(evidence.httpStatusCode),
      };
    }
    if (evidence.httpStatusCode >= 400) {
      return {
        classification: "RETRYABLE",
        reason: `HTTP ${evidence.httpStatusCode} del proveedor de envío -- error transitorio real, puede reintentarse.`,
        isPermanentlyInvalid: false,
        allowsFutureRetry: true,
        matchedCode: String(evidence.httpStatusCode),
      };
    }
  }

  return {
    classification: "UNKNOWN",
    reason: "Sin evidencia textual ni código HTTP suficiente para clasificar -- nunca se inventa una categoría sin evidencia real.",
    isPermanentlyInvalid: false,
    // F34: UNKNOWN se trata como NO reintentable por precaución -- sin
    // evidencia real de que el problema sea transitorio, reintentar a
    // ciegas arriesga volver a golpear la misma dirección inválida.
    allowsFutureRetry: false,
    matchedCode: null,
  };
}
