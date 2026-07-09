import { Router } from "express";
import { convertLeadInputSchema, createLeadInputSchema, leadQuerySchema, updateLeadInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as leadsService from "./service";

export const leadsRouter = Router();

leadsRouter.get("/leads", requirePermission("leads.view"), async (req, res, next) => {
  try {
    const query = leadQuerySchema.parse(req.query);
    res.json(await leadsService.listLeads(query));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/leads", requirePermission("leads.create"), async (req, res, next) => {
  try {
    const input = createLeadInputSchema.parse(req.body);
    res.status(201).json(await leadsService.createLead(input));
  } catch (err) {
    next(err);
  }
});

leadsRouter.get("/leads/:id", requirePermission("leads.view"), async (req, res, next) => {
  try {
    res.json(await leadsService.getLeadDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch("/leads/:id", requirePermission("leads.update"), async (req, res, next) => {
  try {
    const input = updateLeadInputSchema.parse(req.body);
    res.json(await leadsService.updateLead(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post("/leads/:id/convert", requirePermission("leads.update"), async (req, res, next) => {
  try {
    const input = convertLeadInputSchema.parse(req.body);
    res.status(201).json(await leadsService.convertLead(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});
