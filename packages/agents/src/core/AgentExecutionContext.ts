import type { AgentContext } from "./AgentContext";
import type { AgentCapability } from "./AgentCapability";
import type { PolicyEnvelope } from "./PolicyEnvelope";

/**
 * F25 Fase 1: superset de `AgentContext` (F2, sin modificar) -- nunca
 * un tipo paralelo. Todo lo que `AgentContext` ya provee
 * (tenantId/agentInstanceId/taskId/triggeredBy) sigue igual; esto
 * agrega exactamente lo que F25 necesita y `AgentContext` no tenía
 * motivo de tener en F2 (correlación, capacidades resueltas, política
 * vigente). Un handler de tarea que solo necesita lo de F2 puede
 * seguir tipando contra `AgentContext` sin cambios -- este tipo es
 * estrictamente más ancho.
 */
export interface AgentExecutionContext extends AgentContext {
  /** = missionId para todo lo que esa misión origina -- ver docs/F25_AGENT_EVENTS_AND_CONTRACTS.md §3. */
  correlationId: string;
  /** eventId del evento inmediatamente anterior en la cadena, null si esta tarea es la raíz. */
  causationId: string | null;
  /** Capacidades ya resueltas para este AgentInstance -- ver AgentCapability.ts. Nunca se vuelve a resolver dentro del handler. */
  capabilities: readonly AgentCapability[];
  /** Política vigente para este tenant/misión en el momento de la ejecución -- ver PolicyEnvelope.ts. */
  policyEnvelope: PolicyEnvelope;
}
