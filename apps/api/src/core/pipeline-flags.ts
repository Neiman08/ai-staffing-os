import { env } from "./env";

/**
 * F25.2 (activación controlada del pipeline real): un único objeto
 * derivado, nunca strings/env sueltos leídos ad-hoc en cada módulo --
 * todo lo que decide si el pipeline autónomo hace algo real pasa por
 * `PIPELINE_FLAGS`, nunca por un `if` disperso.
 *
 * `PIPELINE_KILL_SWITCH=true` apaga TODO lo gradual de una sola vez
 * (kill switch global, pedido explícito).
 *
 * `externalActionsEnabled`/`autonomousSendingEnabled` son literales
 * `false` -- a propósito NO derivan de ninguna variable de entorno.
 * Ningún valor de configuración, y ningún agente leyendo este objeto,
 * puede encenderlos: cambiarlos exige editar este archivo y pasar por
 * revisión humana de un commit real, no un flag mal puesto en
 * producción. Esto es literal lo que pide la restricción "no permitas
 * que esos flags puedan ser ignorados por un agente" -- un agente NO
 * PUEDE ignorarlos porque ni siquiera son parámetros, son constantes.
 */
export interface PipelineFlagSource {
  PIPELINE_KILL_SWITCH: boolean;
  AUTONOMOUS_WORKER_ENABLED: boolean;
  MISSION_TASK_PRODUCTION_ENABLED: boolean;
  DISCOVERY_AGENT_ENABLED: boolean;
  CONTACT_INTELLIGENCE_AGENT_ENABLED: boolean;
  QUALITY_AGENT_ENABLED: boolean;
  EVENT_HANDLERS_ENABLED: boolean;
  DRAFT_AGENT_ENABLED: boolean;
}

export interface PipelineFlags {
  autonomousWorkerEnabled: boolean;
  missionTaskProductionEnabled: boolean;
  discoveryAgentEnabled: boolean;
  contactIntelligenceAgentEnabled: boolean;
  qualityAgentEnabled: boolean;
  eventHandlersEnabled: boolean;
  // F26 (primer piloto de outreach real): gatea SOLO la creación
  // reactiva del borrador (contact.verified.v1 -> draft_outreach, LLM
  // real). El envío real (sendApproval/sendEmail, Microsoft Graph) NO
  // lee este objeto en absoluto -- sigue gateado exclusivamente por un
  // click humano explícito en "Approve & Send", igual que desde F17.
  draftAgentEnabled: boolean;
  externalActionsEnabled: false;
  autonomousSendingEnabled: false;
}

/** Función pura -- separada del singleton de abajo exclusivamente para poder probar el kill switch sin reimportar `env` con variables distintas. */
export function computePipelineFlags(source: PipelineFlagSource): PipelineFlags {
  const killed = source.PIPELINE_KILL_SWITCH;
  return {
    autonomousWorkerEnabled: !killed && source.AUTONOMOUS_WORKER_ENABLED,
    missionTaskProductionEnabled: !killed && source.MISSION_TASK_PRODUCTION_ENABLED,
    discoveryAgentEnabled: !killed && source.DISCOVERY_AGENT_ENABLED,
    contactIntelligenceAgentEnabled: !killed && source.CONTACT_INTELLIGENCE_AGENT_ENABLED,
    qualityAgentEnabled: !killed && source.QUALITY_AGENT_ENABLED,
    eventHandlersEnabled: !killed && source.EVENT_HANDLERS_ENABLED,
    draftAgentEnabled: !killed && source.DRAFT_AGENT_ENABLED,
    // Nunca derivan de `source` -- ver docstring del archivo.
    externalActionsEnabled: false,
    autonomousSendingEnabled: false,
  };
}

export const PIPELINE_FLAGS: PipelineFlags = computePipelineFlags(env);

export type PipelineFlagKey = keyof PipelineFlags;
