import type { NextFunction, Request, Response } from "express";
import type { PermissionKey } from "@ai-staffing-os/shared";
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
    next();
  };
}
