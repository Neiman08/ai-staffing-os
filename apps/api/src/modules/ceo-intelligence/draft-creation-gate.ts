import type { ContactChannelResolution } from "./contact-channel";

/**
 * F24 (auditoría de producción, pedido explícito del PO -- "un Draft NO
 * debe existir si no existe un canal de contacto válido"): chokepoint
 * ÚNICO y puro, sin Prisma/fetch/LLM, que decide si corresponde crear un
 * ApprovalRequest de outreach para una Company. Los tres call sites
 * reales (discovery-conversion.ts, outreach-tools.impl.ts,
 * sales-tools.impl.ts) lo llaman ANTES de gastar cualquier request al
 * LLM -- mismo criterio que ya usaba outreach-tools.impl.ts para el
 * canal de contacto (F21 Fase 2/3), ahora generalizado a las 4 causas
 * reales encontradas en la auditoría:
 *
 *   1. Company.origin=DEMO_SEED -- dato de fixture, nunca es un
 *      prospecto real (packages/db/prisma/seed.ts).
 *   2. Ya existe un ApprovalRequest activo (PENDING/READY_TO_SEND/
 *      SENDING) para esta Company -- nunca dos conversaciones
 *      comerciales paralelas para el mismo destinatario.
 *   3. isClientOwnerCandidate=true u
 *      opportunityRecommendation="MANUAL_REVIEW" -- el propio sistema ya
 *      sospecha que esta Company es el CLIENTE FINAL (ej. el data center
 *      mismo), no un contratista real -- nunca se redacta outreach
 *      automático mientras esa sospecha esté sin resolver por un humano.
 *   4. Sin canal de contacto EMAIL-capable real (resolveBestContactChannel).
 *
 * Precedencia deliberada: 1 y 2 invalidan el registro entero (ningún fix
 * de contenido/destinatario lo arregla) -- se evalúan primero. 3 es un
 * problema de fondo (la Company entera está mal dirigida) -- se evalúa
 * antes que 4 porque enriquecer el contacto de un cliente final nunca
 * sería la acción correcta. 4 es la única causa "esperable" del día a
 * día (falta de dato, no un error de diseño).
 */

export type OutreachBlockReason = "NEEDS_ENRICHMENT" | "CLIENT_OWNER_REVIEW";
export type DraftCreationBlockReason = "DEMO_SEED" | "DUPLICATE_ACTIVE" | OutreachBlockReason;

export interface DraftCreationGateInput {
  companyOrigin: string;
  isClientOwnerCandidate: boolean;
  /** discoveryMetadata.opportunityRecommendation.recommendation -- null si nunca se calculó. */
  opportunityRecommendation: string | null;
  channel: Pick<ContactChannelResolution, "isEmailCapable" | "channel" | "reason">;
  hasActiveDuplicateApproval: boolean;
}

export interface DraftCreationGateResult {
  allowed: boolean;
  blockReason: DraftCreationBlockReason | null;
  reason: string;
  /** Solo se persiste en Company.outreachBlockedReason cuando aplica -- DEMO_SEED/DUPLICATE_ACTIVE ya son identificables por otros campos, ver el enum en schema.prisma. */
  companyBlockReasonToPersist: OutreachBlockReason | null;
}

export function evaluateDraftCreationGate(input: DraftCreationGateInput): DraftCreationGateResult {
  if (input.companyOrigin === "DEMO_SEED") {
    return {
      allowed: false,
      blockReason: "DEMO_SEED",
      reason: "Company.origin=DEMO_SEED -- dato de prueba/seed, nunca entra al pipeline comercial real.",
      companyBlockReasonToPersist: null,
    };
  }

  if (input.hasActiveDuplicateApproval) {
    return {
      allowed: false,
      blockReason: "DUPLICATE_ACTIVE",
      reason: "Ya existe un ApprovalRequest activo (PENDING/READY_TO_SEND/SENDING) para esta Company -- nunca se crea un segundo borrador en paralelo.",
      companyBlockReasonToPersist: null,
    };
  }

  if (input.isClientOwnerCandidate || input.opportunityRecommendation === "MANUAL_REVIEW") {
    return {
      allowed: false,
      blockReason: "CLIENT_OWNER_REVIEW",
      reason: input.isClientOwnerCandidate
        ? "Esta Company fue marcada isClientOwnerCandidate=true -- probablemente el cliente final (ej. el propio data center), no un contratista real. Requiere revisión humana antes de generar outreach automático."
        : "opportunityRecommendation=MANUAL_REVIEW -- evidencia mixta o insuficiente, requiere revisión humana antes de generar outreach automático.",
      companyBlockReasonToPersist: "CLIENT_OWNER_REVIEW",
    };
  }

  if (!input.channel.isEmailCapable) {
    return {
      allowed: false,
      blockReason: "NEEDS_ENRICHMENT",
      reason: `Sin canal de contacto EMAIL-capable real todavía (mejor canal disponible: ${input.channel.channel} -- ${input.channel.reason}).`,
      companyBlockReasonToPersist: "NEEDS_ENRICHMENT",
    };
  }

  return { allowed: true, blockReason: null, reason: "Canal de contacto real disponible, sin bloqueos -- borrador permitido.", companyBlockReasonToPersist: null };
}
