export const PERMISSION_RESOURCES = [
  "companies",
  "contacts",
  "candidates",
  "workers",
  "jobOrders",
  "documents",
  "timeEntries",
  "pricingScenarios",
  "leads", // F1
  "opportunities", // F1
  "followUps", // F1
  "campaigns", // F4
  "missions", // F4
  "assignments", // F5.4
  "payrollRuns", // F5.7
  "invoices", // F5.8
  "shifts", // F9.6
  "incidents", // F9.10
  // F10.1: recursos de PORTAL -- deliberadamente SEPARADOS de sus
  // equivalentes internos (assignments/timeEntries/documents/incidents)
  // en vez de reutilizar el mismo permission key. Los endpoints internos
  // (GET /assignments, GET /time-entries, etc.) devuelven TODO el
  // tenant sin ningún filtro de ownership -- si un rol de portal
  // recibiera el permiso interno, podría llamar directo a esos
  // endpoints y ver datos de otros Workers/Companies dentro del mismo
  // tenant (IDOR real, no solo entre tenants). Los recursos `portal*`
  // gatean rutas NUEVAS bajo /portal/* cuyo service layer siempre
  // aplica un filtro de ownership explícito (ctx.workerId/candidateId/
  // companyId), nunca confía en el query param. Decisión documentada en
  // docs/F10_PLAN.md §2.
  "clientJobs", // F10.3: solicitudes de personal del cliente (ClientJobRequest) -- recurso nuevo, sin equivalente interno, sin riesgo de colisión.
  "portalProfile", // F10.5: perfil propio (Worker/Candidate/contacto de Company)
  "notifications", // F10.8: centro de notificaciones in-app -- recurso nuevo
  "portalAssignments", // F10.6: assignments/schedule propios (Worker) o de la Company (Client)
  "portalTimeEntries", // F10.7: time entries propios (Worker) o de la Company (Client, para aprobar)
  "portalDocuments", // F10.5: checklist de documentos propio (Worker/Candidate)
  "portalIncidents", // F10.4/F10.6: incidentes relacionados, solo lectura
  "auditLogs", // F10.9: historial de auditoría -- alcance completo para interno, acotado por ownership para portal (mismo permission key, distinto alcance en el service)
] as const;

export const PERMISSION_ACTIONS = ["view", "create", "update", "delete"] as const;

const SPECIAL_PERMISSION_KEYS = [
  "payroll.approve",
  "compliance.verify",
  "compliance.block",
  "agents.view",
  "agents.configure",
  "agents.execute", // F2: invoke a Sales Agent task (distinct from configuring autonomy/settings)
  "approvals.decide",
  "settings.manage",
  "users.manage",
  "invoices.send", // F5.8: transición DRAFT->SENT, distinta de invoices.update (ver permissions.ts comentario histórico)
  "matching.view", // F6.1: ver resultados de matching Job Order <-> Worker
  "matching.run", // F6.1: disparar una corrida de matching — nunca crea Assignments, solo propone
  // F10.1/F10.3: clientJobs ya tiene view/create/update/delete (CRUD) --
  // approve es la única acción que no encaja en CRUD (revisión interna
  // que aprueba/convierte una solicitud, distinta de editarla).
  "clientJobs.approve",
  // F10.8: marcar como leída es una mutación de un solo campo sobre el
  // recurso PROPIO del usuario -- nunca encaja como "update" genérico
  // (update implicaría poder editar el contenido de la notificación).
  "notifications.markRead",
] as const;

const SPECIAL_PERMISSION_LABELS: Record<(typeof SPECIAL_PERMISSION_KEYS)[number], string> = {
  "payroll.approve": "Approve payroll runs",
  "compliance.verify": "Verify compliance documents",
  "compliance.block": "Block/unblock workers",
  "agents.view": "View AI agents",
  "agents.configure": "Configure AI agents",
  "agents.execute": "Execute AI agent tasks",
  "approvals.decide": "Approve/reject approval requests",
  "settings.manage": "Manage tenant settings",
  "users.manage": "Manage users and roles",
  "invoices.send": "Send invoices to clients",
  "matching.view": "View AI matching results",
  "matching.run": "Run AI matching",
  "clientJobs.approve": "Approve/convert a client job request",
  "notifications.markRead": "Mark own notifications as read",
};

type Resource = (typeof PERMISSION_RESOURCES)[number];
type Action = (typeof PERMISSION_ACTIONS)[number];
type CrudPermissionKey = `${Resource}.${Action}`;
export type SpecialPermissionKey = (typeof SPECIAL_PERMISSION_KEYS)[number];
export type PermissionKey = CrudPermissionKey | SpecialPermissionKey;

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
}

function resourceLabel(resource: Resource): string {
  const spaced = resource.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function actionLabel(action: Action): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export const CRUD_PERMISSIONS: PermissionDefinition[] = PERMISSION_RESOURCES.flatMap((resource) =>
  PERMISSION_ACTIONS.map((action) => ({
    key: `${resource}.${action}` as CrudPermissionKey,
    label: `${actionLabel(action)} ${resourceLabel(resource)}`,
  })),
);

export const SPECIAL_PERMISSIONS: PermissionDefinition[] = SPECIAL_PERMISSION_KEYS.map((key) => ({
  key,
  label: SPECIAL_PERMISSION_LABELS[key],
}));

export const ALL_PERMISSIONS: PermissionDefinition[] = [...CRUD_PERMISSIONS, ...SPECIAL_PERMISSIONS];

/**
 * F4.9 §6 (decisión aprobada del PO): permisos que exigen MFA verificado
 * en la sesión actual cuando la política del tenant está activa (ver
 * Tenant.settings.security.mfaEnforced, apps/api/src/core/security-settings.ts).
 * El PO pidió también "invoices.send" — no existía en el vocabulario real
 * de PermissionKey hasta F5.8 (módulo de billing). Ya agregado arriba.
 */
export const MFA_REQUIRED_PERMISSIONS: PermissionKey[] = [
  "payroll.approve",
  "agents.configure",
  "settings.manage",
  "users.manage",
  "invoices.send",
  "approvals.decide",
  "compliance.block",
];
