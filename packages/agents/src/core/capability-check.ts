import type { AgentCapability } from "./AgentCapability";
import type { PolicyEnvelope } from "./PolicyEnvelope";
import { allow, deny, type AgentDecisionResult } from "./AgentDecisionResult";

/**
 * F25 Fase 1 (ADR-0007): única función que decide si una acción
 * concreta está permitida -- nunca un `if` disperso por el código.
 * Dos condiciones, ambas deben cumplirse:
 *   1. La capacidad está en la lista declarada del agente
 *      (`AgentDefinition.availableTools`, ver AgentCapability.ts).
 *   2. La capacidad NO está en `PolicyEnvelope.prohibitedActions` del
 *      tenant/misión vigente -- el envelope siempre puede RESTRINGIR
 *      más allá de lo que el agente declara, nunca ampliar.
 *
 * Puramente declarativa hoy -- nada la llama todavía en producción
 * (eso es F25.5, primero solo logueando violaciones antes de
 * bloquear de verdad, ver roadmap).
 */
export function hasCapability(
  declaredCapabilities: readonly AgentCapability[],
  policyEnvelope: PolicyEnvelope,
  requested: AgentCapability,
): AgentDecisionResult<{ requested: AgentCapability }> {
  const metadata = { requested };

  if (!declaredCapabilities.includes(requested)) {
    return deny(`El agente no declara la capacidad "${requested}" en su AgentDefinition.availableTools.`, metadata);
  }
  if (policyEnvelope.prohibitedActions.includes(requested)) {
    return deny(`La capacidad "${requested}" está explícitamente prohibida por el PolicyEnvelope vigente.`, metadata);
  }
  return allow(metadata);
}
