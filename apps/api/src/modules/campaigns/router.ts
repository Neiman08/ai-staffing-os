import { Router } from "express";
import {
  campaignCompanyTaskInputSchema,
  campaignQuerySchema,
  campaignTaskInputSchema,
  createCampaignInputSchema,
  logConversationInputSchema,
  updateCampaignInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as campaignsService from "./service";

export const campaignsRouter = Router();

campaignsRouter.post("/campaigns", requirePermission("campaigns.create"), async (req, res, next) => {
  try {
    const input = createCampaignInputSchema.parse(req.body);
    res.status(201).json(await campaignsService.createCampaign(input));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.get("/campaigns", requirePermission("campaigns.view"), async (req, res, next) => {
  try {
    const query = campaignQuerySchema.parse(req.query);
    res.json(await campaignsService.listCampaigns(query));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.get("/campaigns/:id", requirePermission("campaigns.view"), async (req, res, next) => {
  try {
    res.json(await campaignsService.getCampaignDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.patch("/campaigns/:id", requirePermission("campaigns.update"), async (req, res, next) => {
  try {
    const input = updateCampaignInputSchema.parse(req.body);
    res.json(await campaignsService.updateCampaign(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.post("/campaigns/:id/tasks", requirePermission("agents.execute"), async (req, res, next) => {
  try {
    const input = campaignTaskInputSchema.parse(req.body);
    res.status(202).json(await campaignsService.triggerCampaignTask(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.get("/campaign-companies/:id", requirePermission("campaigns.view"), async (req, res, next) => {
  try {
    res.json(await campaignsService.getCampaignCompanyDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

campaignsRouter.post(
  "/campaign-companies/:id/tasks",
  requirePermission("agents.execute"),
  async (req, res, next) => {
    try {
      const input = campaignCompanyTaskInputSchema.parse(req.body);
      res.status(202).json(await campaignsService.triggerCampaignCompanyTask(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);

// F4 §15: única forma de "entrada" hasta que exista integración real de
// bandeja (F4.5) — un humano pega la respuesta que recibió. Corre
// síncrono (ver service.ts) para que la clasificación aparezca al toque.
campaignsRouter.post(
  "/campaign-companies/:id/conversation",
  requirePermission("agents.execute"),
  async (req, res, next) => {
    try {
      const input = logConversationInputSchema.parse(req.body);
      res.json(await campaignsService.logConversation(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);
