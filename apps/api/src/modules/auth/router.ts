import { Router } from "express";
import { inviteUserInputSchema, setUserStatusInputSchema, changeUserRoleInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { userInviteLimiter } from "../../core/rate-limiters";
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

authRouter.get("/users/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    res.json(await authService.getUserDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// F4.9 §5: "no enviar invitaciones reales sin mi aprobación" — decisión
// de producto, no de código: este endpoint SÍ envía una invitación real
// cuando AUTH_MODE=clerk (ver service.ts inviteUser). Queda funcional y
// gateado por users.manage; su uso real en producción es una decisión
// separada del PO, no algo que este código pueda impedir por sí solo.
authRouter.post("/users/invite", userInviteLimiter, requirePermission("users.manage"), async (req, res, next) => {
  try {
    const input = inviteUserInputSchema.parse(req.body);
    res.status(201).json(await authService.inviteUser(input));
  } catch (err) {
    next(err);
  }
});

authRouter.patch("/users/:id/status", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const input = setUserStatusInputSchema.parse(req.body);
    await authService.setUserStatus(req.params.id!, input);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.patch("/users/:id/role", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const input = changeUserRoleInputSchema.parse(req.body);
    await authService.changeUserRole(req.params.id!, input);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.post("/users/:id/revoke-sessions", requirePermission("users.manage"), async (req, res, next) => {
  try {
    await authService.revokeUserSessions(req.params.id!);
    res.status(204).end();
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
