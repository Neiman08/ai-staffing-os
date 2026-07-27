/**
 * F25 Fase 1: helpers de idempotencia -- docs/F25_AGENT_EVENTS_AND_CONTRACTS.md
 * §4. Deliberadamente simple (un join de partes con `:`) -- la
 * garantía REAL de idempotencia para acciones irreversibles sigue
 * viviendo en una constraint de base de datos cuando existe una
 * (ej. el índice único parcial de ApprovalRequest, F24). Este helper
 * es la primera línea (mensaje de error claro, rápido, antes de
 * gastar un intento contra un proveedor externo), nunca la única.
 */
export function buildIdempotencyKey(...parts: string[]): string {
  if (parts.length === 0) throw new Error("buildIdempotencyKey requiere al menos una parte");
  if (parts.some((p) => !p || p.includes(":"))) {
    throw new Error(`buildIdempotencyKey: ninguna parte puede estar vacía ni contener ":" (recibido: ${JSON.stringify(parts)})`);
  }
  return parts.join(":");
}
