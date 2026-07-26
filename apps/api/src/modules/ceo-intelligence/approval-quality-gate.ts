import { findKnownPlaceholders } from "@ai-staffing-os/shared";
import { isPhoneContaminated } from "./contact-channel";

/**
 * F24 Fase 8 (auditoría de producción, pedido explícito del PO): "antes
 * de Approval agrega un Quality Gate" -- última línea de defensa,
 * evaluada en decideApproval justo antes de permitir APPROVED (nunca
 * REJECTED, que siempre debe poder cerrarse sin condiciones). Puro, sin
 * Prisma/fetch/LLM -- mismo criterio que el resto de ceo-intelligence/.
 *
 * Defensa en profundidad deliberada: evaluateDraftCreationGate
 * (draft-creation-gate.ts) ya debería haber bloqueado la mayoría de
 * estos casos ANTES de que el Draft existiera -- pero un borrador
 * generado antes de esa fase (o por un shape/agente que todavía no pasa
 * por ese gate) puede seguir esperando aprobación. Nunca se asume que la
 * creación fue válida solo porque el registro existe.
 */

const EMAIL_SYNTAX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ApprovalQualityGateInput {
  /** null cuando la Company no se pudo resolver (proposedAction roto/legacy). */
  companyOrigin: string | null;
  companyCommercialStatus: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  /** true si existe OTRO ApprovalRequest activo (no este mismo) para la misma Company. */
  hasOtherActiveDuplicateApproval: boolean;
  /**
   * Bug real encontrado en auditoría de "primera misión real":
   * evaluateDraftCreationGate (draft-creation-gate.ts) solo se evalúa al
   * CREAR el borrador. Un re-discovery/re-enrichment posterior puede
   * marcar la Company como isClientOwnerCandidate=true/MANUAL_REVIEW
   * DESPUÉS de que el borrador ya existe y sigue PENDING -- sin este
   * re-chequeo acá, un humano podía aprobar outreach hacia lo que el
   * propio sistema ya detectó como el cliente final real. Opcionales
   * (default false/null) para no romper a los callers existentes
   * (quality.executor.ts, vía el pipeline reactivo) que todavía no los
   * pasan -- decideApproval (approvals/service.ts), el gate humano
   * final y autoritativo, sí los pasa siempre con el dato fresco.
   */
  isClientOwnerCandidate?: boolean;
  opportunityRecommendation?: string | null;
}

export interface ApprovalQualityCheckFailure {
  check:
    | "company_valid"
    | "classification_valid"
    | "contact_valid"
    | "email_valid"
    | "no_placeholders"
    | "no_duplicates"
    | "content_complete"
    | "minimal_metadata"
    | "client_owner_review";
  reason: string;
}

export interface ApprovalQualityGateResult {
  passed: boolean;
  failures: ApprovalQualityCheckFailure[];
}

export function evaluateApprovalQualityGate(input: ApprovalQualityGateInput): ApprovalQualityGateResult {
  const failures: ApprovalQualityCheckFailure[] = [];

  // ✓ metadata mínima -- sin esto ningún otro chequeo de Company tiene sentido.
  if (!input.companyOrigin && !input.companyCommercialStatus) {
    failures.push({ check: "minimal_metadata", reason: "No se pudo resolver la Company asociada a este borrador (proposedAction sin companyId/leadId/campaignCompanyId resoluble)." });
  }

  // ✓ Company válida
  if (input.companyOrigin === "DEMO_SEED") {
    failures.push({ check: "company_valid", reason: "Company.origin=DEMO_SEED -- dato de prueba/seed, nunca aprobable para envío real." });
  }

  // ✓ clasificación válida
  if (input.companyCommercialStatus === "DISCOVERY_CANDIDATE") {
    failures.push({ check: "classification_valid", reason: "Company.commercialStatus=DISCOVERY_CANDIDATE -- tipo de negocio todavía sin validar." });
  }

  // ✓ nunca aprobable si un (re-)discovery posterior a la creación del
  // borrador marcó esta Company como probable cliente final real -- mismo
  // criterio exacto que evaluateDraftCreationGate al crear el borrador.
  if (input.isClientOwnerCandidate || input.opportunityRecommendation === "MANUAL_REVIEW") {
    failures.push({
      check: "client_owner_review",
      reason: input.isClientOwnerCandidate
        ? "Esta Company fue marcada isClientOwnerCandidate=true -- probablemente el cliente final (ej. el propio data center), no un contratista real. Requiere revisión humana antes de aprobar outreach."
        : "opportunityRecommendation=MANUAL_REVIEW -- evidencia mixta o insuficiente, requiere revisión humana antes de aprobar outreach.",
    });
  }

  // ✓ contacto válido
  if (!input.to) {
    failures.push({ check: "contact_valid", reason: "Sin destinatario resoluble -- este borrador fallaría al intentar enviarse." });
  } else {
    // ✓ email válido (sintaxis + sin contaminación de teléfono)
    if (!EMAIL_SYNTAX_RE.test(input.to)) {
      failures.push({ check: "email_valid", reason: `El destinatario "${input.to}" no tiene sintaxis de email válida.` });
    } else if (isPhoneContaminated(input.to)) {
      failures.push({ check: "email_valid", reason: `El destinatario "${input.to}" parece contaminado con una secuencia telefónica -- verificar y corregir con "Editar borrador" antes de aprobar.` });
    }
  }

  // ✓ sin placeholders
  const placeholders = findKnownPlaceholders(input.body);
  if (placeholders.length > 0) {
    failures.push({ check: "no_placeholders", reason: `El cuerpo tiene placeholders sin completar: ${placeholders.join(", ")}.` });
  }

  // ✓ sin duplicados
  if (input.hasOtherActiveDuplicateApproval) {
    failures.push({ check: "no_duplicates", reason: "Ya existe otro ApprovalRequest activo para la misma Company -- resolver el duplicado antes de aprobar este." });
  }

  // ✓ contenido completo
  if (!input.subject || !input.subject.trim()) {
    failures.push({ check: "content_complete", reason: "El asunto está vacío." });
  }
  if (!input.body || !input.body.trim()) {
    failures.push({ check: "content_complete", reason: "El cuerpo está vacío." });
  }

  return { passed: failures.length === 0, failures };
}
