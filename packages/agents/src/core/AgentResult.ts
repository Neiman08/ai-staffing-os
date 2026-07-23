import type { AgentEventEnvelope } from "./AgentEventEnvelope";
import type { AgentError } from "./AgentError";

/**
 * F25 Fase 1: lo que un handler de tarea devuelve -- nunca una
 * excepción cruda sin clasificar (principio #8, "los errores no deben
 * dejar entidades en estados ambiguos"). `events` son los eventos que
 * el Orchestrator debe publicar (vía outbox, F25.3) SI Y SOLO SI el
 * resultado es éxito -- un handler nunca publica eventos directamente,
 * los declara como parte de su resultado para que el llamador los
 * escriba en la misma transacción que persiste el resto del efecto
 * (mismo principio de outbox que ADR-0002).
 */
export type AgentResult<TOutput> =
  | { success: true; output: TOutput; events: AgentEventEnvelope[] }
  | { success: false; error: AgentError };

export function agentSuccess<TOutput>(output: TOutput, events: AgentEventEnvelope[] = []): AgentResult<TOutput> {
  return { success: true, output, events };
}

export function agentFailure<TOutput>(error: AgentError): AgentResult<TOutput> {
  return { success: false, error };
}
