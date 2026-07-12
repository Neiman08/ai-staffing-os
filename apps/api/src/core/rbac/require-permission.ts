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
