/**
 * F2 §9: qué acciones del Sales Agent requieren aprobación humana antes de
 * darse por "listas para usar". Tabla explícita en vez de un flag genérico
 * en cada tool: hace la política auditable y fácil de revisar en un PR sin
 * tener que leer cada implementación.
 *
 * Hoy solo draftOutreach — es la única tool que produce contenido pensado
 * para llegar a alguien fuera del tenant (F2 regla: "el humano debe
 * aprobar cualquier outreach externo").
 */
const TOOLS_REQUIRING_APPROVAL = new Set<string>(["draftOutreach"]);

export function requiresApproval(toolName: string): boolean {
  return TOOLS_REQUIRING_APPROVAL.has(toolName);
}
