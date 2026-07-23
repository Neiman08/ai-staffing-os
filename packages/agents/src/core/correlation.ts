/**
 * F25 Fase 1: helpers de correlación -- docs/F25_AGENT_EVENTS_AND_CONTRACTS.md
 * §3. `correlationId` es SIEMPRE el `missionId` raíz (nunca un id
 * distinto por sub-tarea) -- estos helpers existen para que nadie
 * tenga que recordar esa regla a mano en cada nuevo publisher.
 */

/** El correlationId de una misión ES su propio id -- nunca se genera uno nuevo. */
export function rootCorrelationId(missionId: string): string {
  return missionId;
}

/** Toda tarea/evento derivado de una misión hereda literalmente el mismo correlationId -- nunca lo deriva ni lo transforma. */
export function deriveCorrelationId(parentCorrelationId: string): string {
  return parentCorrelationId;
}
