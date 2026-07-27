/**
 * F25 Fase 1: vocabulario compartido de etapas del pipeline comercial
 * autónomo -- ver docs/F25_AUTONOMOUS_ORGANIZATION_MASTER_ARCHITECTURE.md
 * §6. Puramente descriptivo hoy (no existe ninguna columna que lo
 * persista todavía -- eso es F25.2, cuando tenga sentido agregarlo en
 * la misma migración que el resto del lease de AgentTask). Sirve para
 * etiquetar logs/eventos/AuditLog de forma consistente desde ya, sin
 * esperar la migración.
 */
export const AGENT_STAGES = [
  "STRATEGY",
  "DISCOVERY",
  "COMPANY_RESEARCH",
  "CONTACT_INTELLIGENCE",
  "ENRICHMENT",
  "QUALIFICATION",
  "CAMPAIGN_PLANNING",
  "OUTREACH_DRAFTING",
  "QUALITY_REVIEW",
  "APPROVAL",
  "DELIVERY",
  "REPLY_INGESTION",
  "REPLY_CLASSIFICATION",
  "CONVERSATION",
  "MEETING_BOOKING",
  "CRM_UPDATE",
  "ANALYTICS",
  "LEARNING",
] as const;

export type AgentStage = (typeof AGENT_STAGES)[number];

export function isAgentStage(value: string): value is AgentStage {
  return (AGENT_STAGES as readonly string[]).includes(value);
}
