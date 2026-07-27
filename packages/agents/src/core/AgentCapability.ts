/**
 * F25 Fase 1 (ADR-0007): catálogo cerrado de capacidades que un agente
 * puede declarar/pedir. Vive en `AgentDefinition.availableTools`
 * (columna Json ya existente, hoy sin contenido significativo) -- ver
 * docs/adr/0007-capability-and-policy-model.md. Declarar una capacidad
 * acá no la habilita por sí sola: `hasCapability` (capability-check.ts)
 * es la única función que decide si una acción concreta está permitida,
 * y SEND_EMAIL/BOOK_MEETING nunca están otorgadas por el
 * PolicyEnvelope default de ningún tenant (ver PolicyEnvelope.ts).
 */
export const AGENT_CAPABILITIES = [
  // Estrategia y coordinación
  "CREATE_STRATEGIC_MISSION",
  "READ_ANALYTICS",
  "SET_BUDGET_ALLOCATION",
  "PAUSE_PIPELINE",
  "CLAIM_TASK",
  "CREATE_TASK",
  "RETRY_TASK",
  "CANCEL_TASK",
  "ESCALATE_BLOCKED_TASK",
  "READ_WORKER_CAPACITY",
  "PROPOSE_TERRITORY",
  // Discovery / Research / Contact
  "DISCOVER_COMPANY",
  "READ_COMPANY",
  "UPDATE_COMPANY_RESEARCH",
  "CREATE_CONTACT_CANDIDATE",
  "VERIFY_CONTACT",
  "RETRY_ENRICHMENT",
  "DECLARE_UNRESOLVABLE",
  // Qualification / Campaign / Outreach / Quality
  "CREATE_QUALIFICATION_ASSESSMENT",
  "CREATE_CAMPAIGN_PLAN",
  "CREATE_DRAFT",
  "CREATE_QUALITY_ASSESSMENT",
  "REQUEST_APPROVAL",
  // Policy / Delivery -- las más sensibles del catálogo
  "ENFORCE_POLICY",
  "TRIGGER_KILL_SWITCH",
  "SEND_EMAIL",
  // Reply / Conversation / Meeting -- diseño, no activo (ver catálogo)
  "READ_INBOX",
  "CLASSIFY_REPLY",
  "DRAFT_REPLY",
  "PROPOSE_WITHIN_RANGE",
  "CREATE_MEETING_PROPOSAL",
  "BOOK_MEETING",
  // CRM / Analytics / Learning / Human review
  "UPDATE_PIPELINE",
  "PUBLISH_REPORT",
  "PROPOSE_LEARNING_CHANGE",
  "CREATE_HUMAN_REVIEW",
  "DEDUPLICATE_REVIEW_REQUESTS",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export function isAgentCapability(value: string): value is AgentCapability {
  return (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

// F25 (ADR-0007): las dos únicas capacidades con impacto externo
// irreversible del catálogo -- nunca están en el PolicyEnvelope default
// de ningún tenant (ver PolicyEnvelope.ts DEFAULT_POLICY_ENVELOPE).
export const HIGH_RISK_CAPABILITIES: readonly AgentCapability[] = ["SEND_EMAIL", "BOOK_MEETING"];
