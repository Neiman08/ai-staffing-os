import { Router } from "express";
import { requirePermission } from "../../core/rbac/require-permission";
import * as notificationsService from "./service";

// F10.8: mismas rutas para TODOS los roles (internos y de portal) --
// `notifications.view`/`.markRead` ya existen en los 15 roles desde
// F10.1, el scoping real ocurre en el service (userId/recipientRole).
export const notificationsRouter = Router();

notificationsRouter.get("/notifications", requirePermission("notifications.view"), async (req, res, next) => {
  try {
    res.json(
      await notificationsService.listNotifications({
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        unreadOnly: req.query.unreadOnly === "true",
      }),
    );
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get("/notifications/unread-count", requirePermission("notifications.view"), async (_req, res, next) => {
  try {
    res.json({ count: await notificationsService.countUnreadNotifications() });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/notifications/:id/read", requirePermission("notifications.markRead"), async (req, res, next) => {
  try {
    res.json(await notificationsService.markNotificationRead(req.params.id!));
  } catch (err) {
    next(err);
  }
});
