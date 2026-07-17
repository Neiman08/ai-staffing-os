/**
 * F7.7: Contact Intelligence -- puro, determinista, sin Prisma/fetch/LLM
 * (mismo criterio que el resto de ceo-intelligence/). Decide si el
 * `title` real de un candidato de un proveedor de contactos (People
 * Data Labs hoy) corresponde a alguno de los roles que F7.6
 * (role-planning.ts) planificó buscar para esta Company -- nunca al
 * revés: el título real de la fuente siempre manda, esto solo compara
 * texto, nunca inventa ni infiere un cargo que la fuente no trajo.
 *
 * Dos criterios, en orden (el primero que matchee gana):
 * 1. Coincidencia de substring normalizada (ej. "HR Manager" matchea
 *    "Senior HR Manager, Midwest Region") -- cubre la mayoría de los
 *    casos reales sin depender de un vocabulario cerrado.
 * 2. Fallback: ambos títulos se clasifican con el mismo mapeo cerrado
 *    ya usado por el Contact Intelligence Agent clásico
 *    (mapTitleToDecisionRole, contact-intelligence-tools.impl.ts) --
 *    cubre variantes que el substring no detecta (ej. "Talent
 *    Acquisition Specialist" vs. planned role "Recruiter").
 */

export const CONTACT_ROLE_MATCH_VERSION = 1;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Devuelve el primer targetRole (tal como vino, sin normalizar) que
 * matchea el título real, o null si ninguno matchea -- en cuyo caso el
 * candidato se descarta (irrelevante para esta misión), nunca se
 * persiste "por si acaso".
 */
export function matchTitleToPlannedRole(
  title: string | null,
  targetRoles: string[],
  mapTitleToDecisionRole: (title: string | null) => string | null,
): string | null {
  if (!title || targetRoles.length === 0) return null;
  const normalizedTitle = normalize(title);

  for (const targetRole of targetRoles) {
    const normalizedRole = normalize(targetRole);
    if (normalizedTitle.includes(normalizedRole) || normalizedRole.includes(normalizedTitle)) {
      return targetRole;
    }
  }

  const titleDecisionRole = mapTitleToDecisionRole(title);
  if (!titleDecisionRole) return null;
  for (const targetRole of targetRoles) {
    if (mapTitleToDecisionRole(targetRole) === titleDecisionRole) return targetRole;
  }

  return null;
}
