/**
 * F25 Fase 1: shape común propuesto para toda función de gate
 * determinista nueva -- docs/F25_AUTONOMOUS_ORGANIZATION_MASTER_ARCHITECTURE.md
 * §5. Los gates de F24 ya en producción
 * (`evaluateDraftCreationGate`, `evaluateApprovalQualityGate`) NO se
 * refactorizan retroactivamente a este shape en esta sesión --
 * cambiarían código productivo probado sin necesidad real. Este tipo
 * es la convención para gates NUEVOS a partir de F25 en adelante (ej.
 * `hasCapability`, `checkDomainSaturation` del roadmap).
 */
export interface AgentDecisionResult<TMetadata = Record<string, unknown>> {
  allowed: boolean;
  /** Nunca vacío cuando allowed=false -- cada razón debe ser accionable por un humano, mismo criterio que F24 (AppError.badRequest con mensaje concreto). */
  reasons: string[];
  metadata: TMetadata;
}

export function allow<TMetadata = Record<string, unknown>>(metadata: TMetadata): AgentDecisionResult<TMetadata> {
  return { allowed: true, reasons: [], metadata };
}

export function deny<TMetadata = Record<string, unknown>>(reasons: string | string[], metadata: TMetadata): AgentDecisionResult<TMetadata> {
  return { allowed: false, reasons: Array.isArray(reasons) ? reasons : [reasons], metadata };
}
