import type { NextFunction, Request, Response } from "express";
import { MFA_REQUIRED_PERMISSIONS, type PermissionKey } from "@ai-staffing-os/shared";
import { AppError } from "../errors";
import { getTenancyContext } from "../tenancy/context";

export function requirePermission(permission: PermissionKey) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getTenancyContext();
    if (!ctx) {
      next(AppError.unauthorized("No authenticated context"));
      return;
    }
    if (!ctx.permissions.includes(permission)) {
      next(AppError.forbidden(`Missing permission: ${permission}`));
      return;
    }
    // F4.9 §6 (decisión aprobada del PO): un token/sesión válida nunca
    // alcanza para ejecutar un permiso sensible si la política de MFA
    // del tenant está activa y esta sesión no verificó un segundo
    // factor — nunca se confía en que el frontend solo muestre un
    // aviso. ctx.mfaEnforced/mfaVerified son undefined en contextos
    // sintéticos (scheduler/agentes), donde el gate no aplica.
    if (ctx.mfaEnforced && !ctx.mfaVerified && MFA_REQUIRED_PERMISSIONS.includes(permission)) {
      next(new AppError(403, "MFA_REQUIRED", `Permission "${permission}" requires MFA to be verified`));
      return;
    }
    next();
  };
}

/**
 * F5.1: bug real encontrado al conectar el formulario de creación de Job
 * Order — GET /job-categories y GET /industries (catálogos de referencia
 * compartidos, packages/talent) solo aceptaban candidates.view. Operations
 * (el único rol, junto a CEO/Admin, con jobOrders.create) nunca tiene
 * candidates.view en el seed — el selector de categoría del formulario
 * habría devuelto 403 para el rol que en teoría puede crear Job Orders.
 * Esta variante exige AL MENOS UNO de los permisos dados, nunca todos —
 * no le quita acceso a nadie que ya lo tuviera, solo agrega una vía
 * alternativa para datos que legítimamente sirven a más de un dominio.
 */
export function requireAnyPermission(permissions: PermissionKey[]) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getTenancyContext();
    if (!ctx) {
      next(AppError.unauthorized("No authenticated context"));
      return;
    }
    if (!permissions.some((p) => ctx.permissions.includes(p))) {
      next(AppError.forbidden(`Missing permission: one of [${permissions.join(", ")}]`));
      return;
    }
    if (ctx.mfaEnforced && !ctx.mfaVerified && permissions.some((p) => MFA_REQUIRED_PERMISSIONS.includes(p))) {
      next(new AppError(403, "MFA_REQUIRED", `This action requires MFA to be verified`));
      return;
    }
    next();
  };
}

/**
 * F5.2: convert-to-worker requiere DOS permisos a la vez (candidates.update
 * Y workers.create) — decisión explícita del PO de dejar la conversión
 * restringida a roles con ambos (hoy CEO/Admin), como segunda validación
 * después del trabajo del Recruiter (que solo tiene candidates.*). Todas
 * las claves deben estar presentes, a diferencia de requireAnyPermission.
 */
export function requireAllPermissions(permissions: PermissionKey[]) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getTenancyContext();
    if (!ctx) {
      next(AppError.unauthorized("No authenticated context"));
      return;
    }
    if (!permissions.every((p) => ctx.permissions.includes(p))) {
      next(AppError.forbidden(`Missing permission(s): all of [${permissions.join(", ")}] are required`));
      return;
    }
    if (ctx.mfaEnforced && !ctx.mfaVerified && permissions.some((p) => MFA_REQUIRED_PERMISSIONS.includes(p))) {
      next(new AppError(403, "MFA_REQUIRED", `This action requires MFA to be verified`));
      return;
    }
    next();
  };
}

/**
 * Pre-F11 audit finding (revenue/summary + dashboard/audit-log, confirmed
 * exploitable live via dev-bypass as a portal identity): several internal,
 * tenant-wide endpoints (F0/F1-era "visible to every authenticated role"
 * dashboards) were never designed with portals in mind, because portals
 * didn't exist yet. They rely on a resource permission (or, per F6.8, on
 * field-level omission inside the service) to keep INTERNAL roles scoped —
 * but F10's portal roles (CLIENT_ADMIN/CLIENT_MANAGER/WORKER/CANDIDATE) can
 * carry unrelated "portal*" permissions that happen to share a permission
 * key with an internal one (e.g. auditLogs.view, used both by F10.9's
 * self-scoped portal audit trail and by this endpoint's tenant-wide dump),
 * so a permission check alone is not a safe gate here. A portal identity
 * (ctx.companyId/workerId/candidateId set) must never reach an
 * internal-only endpoint, regardless of which permissions it holds —
 * mirrors the ownership-check pattern already used by every portal
 * service (F10.1), just applied in the opposite direction.
 */
export function requireInternalIdentity() {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = getTenancyContext();
    if (!ctx) {
      next(AppError.unauthorized("No authenticated context"));
      return;
    }
    if (ctx.companyId || ctx.workerId || ctx.candidateId) {
      next(AppError.forbidden("This endpoint is not available to portal identities"));
      return;
    }
    next();
  };
}
