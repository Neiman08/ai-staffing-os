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
 * El PO pidió también "invoices.send" — no existe en el vocabulario real
 * de PermissionKey (no hay módulo de invoices/billing todavía, ver
 * PERMISSION_RESOURCES arriba); se omite acá en vez de inventar un
 * permiso que ningún Role/endpoint usa. Agregar cuando exista.
 */
export const MFA_REQUIRED_PERMISSIONS: PermissionKey[] = [
  "payroll.approve",
  "agents.configure",
  "settings.manage",
  "users.manage",
  "approvals.decide",
  "compliance.block",
];
