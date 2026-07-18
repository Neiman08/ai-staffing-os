/**
 * F9.3: Compliance Rules -- puro, determinista, sin Prisma/fetch/LLM.
 * Motor de reglas de compliance CONFIGURABLES (por tenant/estado/
 * industria/cliente/categoría de puesto/tipo de asignación) -- extiende
 * el sistema ya existente de `compliance/service.ts` (F5.5, alertas +
 * `Worker.complianceStatus` fijo COMPLIANT/PENDING/BLOCKED), nunca lo
 * reemplaza. Este módulo produce un resultado de EVALUACIÓN más rico
 * (requiredChecks/satisfiedChecks/missingChecks/expiredChecks/blockers/
 * warnings/manualReviewFlags) consumiendo `Worker.complianceStatus`
 * como una señal más, nunca recalculándolo.
 *
 * IMPORTANTE: este módulo NUNCA afirma cumplimiento legal. Los textos
 * usan deliberadamente "checklist completed" / "operationally ready" /
 * "requires manual compliance review" -- cualquier interpretación legal
 * real queda fuera del alcance de un motor automático.
 */

export const COMPLIANCE_RULES_VERSION = 1;

export type ComplianceEvaluationStatus = "NOT_EVALUATED" | "INCOMPLETE" | "NEEDS_REVIEW" | "BLOCKED" | "READY";

export interface ComplianceRuleScope {
  state: string | null;
  industryId: string | null;
  companyId: string | null;
  jobCategoryId: string | null;
  assignmentType: string | null;
}

export interface ComplianceRuleDefinition {
  id: string;
  name: string;
  scope: ComplianceRuleScope;
  requiredDocumentTypeKeys: string[];
  active: boolean;
}

export interface ComplianceEvaluationContext {
  state: string | null;
  industryId: string | null;
  companyId: string | null;
  jobCategoryId: string | null;
  assignmentType: string | null;
}

/**
 * Un campo de scope en `null` significa "aplica a cualquier valor" --
 * un campo NO nulo debe coincidir exactamente. Determinista: la misma
 * combinación de reglas+contexto siempre selecciona el mismo subconjunto.
 */
function ruleApplies(rule: ComplianceRuleDefinition, ctx: ComplianceEvaluationContext): boolean {
  if (!rule.active) return false;
  if (rule.scope.state !== null && rule.scope.state !== ctx.state) return false;
  if (rule.scope.industryId !== null && rule.scope.industryId !== ctx.industryId) return false;
  if (rule.scope.companyId !== null && rule.scope.companyId !== ctx.companyId) return false;
  if (rule.scope.jobCategoryId !== null && rule.scope.jobCategoryId !== ctx.jobCategoryId) return false;
  if (rule.scope.assignmentType !== null && rule.scope.assignmentType !== ctx.assignmentType) return false;
  return true;
}

export function selectApplicableRules(
  rules: ComplianceRuleDefinition[],
  ctx: ComplianceEvaluationContext,
): ComplianceRuleDefinition[] {
  return rules.filter((r) => ruleApplies(r, ctx));
}

export type DocumentCheckStatus = "VERIFIED" | "EXPIRED" | "UNDER_REVIEW" | "MISSING";

export interface DocumentCheckInput {
  documentTypeKey: string;
  status: DocumentCheckStatus;
}

export interface ComplianceEvaluationResult {
  requiredChecks: string[];
  satisfiedChecks: string[];
  missingChecks: string[];
  expiredChecks: string[];
  blockers: string[];
  warnings: string[];
  manualReviewFlags: string[];
  complianceStatus: ComplianceEvaluationStatus;
  rulesVersion: number;
  evaluatedAt: string;
}

export type WorkerComplianceStatusLike = "COMPLIANT" | "PENDING" | "BLOCKED";

/**
 * Evalúa el conjunto de reglas YA seleccionadas (`selectApplicableRules`)
 * contra el estado real de documentos (`documentChecks`, reunidos por el
 * wiring impuro a partir de `Document`/`DocumentChecklistItem` ya
 * existentes -- nunca inventados acá) y el `Worker.complianceStatus` ya
 * calculado por F5.5 (consumido como señal, nunca recalculado).
 */
export function evaluateComplianceRules(
  applicableRules: ComplianceRuleDefinition[],
  documentChecks: DocumentCheckInput[],
  workerComplianceStatus: WorkerComplianceStatusLike,
  now: Date = new Date(),
): ComplianceEvaluationResult {
  const requiredChecks = [...new Set(applicableRules.flatMap((r) => r.requiredDocumentTypeKeys))].sort();
  const checksByKey = new Map(documentChecks.map((c) => [c.documentTypeKey, c.status]));

  const satisfiedChecks: string[] = [];
  const missingChecks: string[] = [];
  const expiredChecks: string[] = [];
  const manualReviewFlags: string[] = [];

  for (const key of requiredChecks) {
    const status = checksByKey.get(key) ?? "MISSING";
    if (status === "VERIFIED") {
      satisfiedChecks.push(key);
    } else if (status === "EXPIRED") {
      expiredChecks.push(key);
      missingChecks.push(key);
    } else if (status === "UNDER_REVIEW") {
      manualReviewFlags.push(`"${key}" requires manual compliance review before it can be counted as satisfied.`);
      missingChecks.push(key);
    } else {
      missingChecks.push(key);
    }
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (expiredChecks.length > 0) {
    blockers.push(`Expired document(s) requiring renewal: ${expiredChecks.join(", ")}.`);
  }
  if (workerComplianceStatus === "BLOCKED") {
    blockers.push("Worker.complianceStatus is BLOCKED (see unresolved compliance alerts).");
  } else if (workerComplianceStatus === "PENDING") {
    warnings.push("Worker.complianceStatus is PENDING (see compliance alerts).");
  }
  if (missingChecks.length > expiredChecks.length + manualReviewFlags.length) {
    const trulyMissing = missingChecks.filter((k) => !expiredChecks.includes(k));
    if (trulyMissing.length > 0) warnings.push(`Missing document(s): ${trulyMissing.join(", ")}.`);
  }

  let complianceStatus: ComplianceEvaluationStatus;
  if (expiredChecks.length > 0 || workerComplianceStatus === "BLOCKED") {
    complianceStatus = "BLOCKED";
  } else if (manualReviewFlags.length > 0) {
    complianceStatus = "NEEDS_REVIEW";
  } else if (missingChecks.length > 0) {
    complianceStatus = "INCOMPLETE";
  } else {
    complianceStatus = "READY";
  }

  return {
    requiredChecks,
    satisfiedChecks,
    missingChecks,
    expiredChecks,
    blockers,
    warnings,
    manualReviewFlags,
    complianceStatus,
    rulesVersion: COMPLIANCE_RULES_VERSION,
    evaluatedAt: now.toISOString(),
  };
}

/** Texto de resumen SIN afirmar cumplimiento legal -- ver comentario del módulo. */
export function describeComplianceStatus(status: ComplianceEvaluationStatus): string {
  switch (status) {
    case "READY":
      return "Checklist completed -- operationally ready per configured rules.";
    case "NEEDS_REVIEW":
      return "Requires manual compliance review before proceeding.";
    case "INCOMPLETE":
      return "Checklist incomplete -- required documents still missing.";
    case "BLOCKED":
      return "Blocked -- expired document(s) or an unresolved compliance block.";
    case "NOT_EVALUATED":
      return "Not evaluated yet.";
  }
}
