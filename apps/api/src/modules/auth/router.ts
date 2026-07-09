import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as authService from "./service";

export const authRouter = Router();

authRouter.get("/me", async (_req, res, next) => {
  try {
    res.json(await authService.getCurrentUser());
  } catch (err) {
    next(err);
  }
});

authRouter.get("/users", requirePermission("users.manage"), async (_req, res, next) => {
  try {
    res.json(await authService.listUsers());
  } catch (err) {
    next(err);
  }
});

authRouter.get("/roles", requirePermission("settings.manage"), async (_req, res, next) => {
  try {
    res.json(await authService.listRoles());
  } catch (err) {
    next(err);
  }
});
