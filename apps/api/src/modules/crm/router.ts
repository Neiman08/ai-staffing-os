import { Router } from "express";
import {
  companyQuerySchema,
  contactInputSchema,
  contactQuerySchema,
  createCompanyInputSchema,
  updateCompanyInputSchema,
  updateContactInputSchema,
} from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import * as crmService from "./service";

export const crmRouter = Router();

crmRouter.get("/companies", requirePermission("companies.view"), async (req, res, next) => {
  try {
    const query = companyQuerySchema.parse(req.query);
    res.json(await crmService.listCompanies(query));
  } catch (err) {
    next(err);
  }
});

crmRouter.post("/companies", requirePermission("companies.create"), async (req, res, next) => {
  try {
    const input = createCompanyInputSchema.parse(req.body);
    res.status(201).json(await crmService.createCompany(input));
  } catch (err) {
    next(err);
  }
});

crmRouter.get("/companies/:id", requirePermission("companies.view"), async (req, res, next) => {
  try {
    res.json(await crmService.getCompanyDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

crmRouter.patch("/companies/:id", requirePermission("companies.update"), async (req, res, next) => {
  try {
    const input = updateCompanyInputSchema.parse(req.body);
    res.json(await crmService.updateCompany(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

crmRouter.get("/contacts", requirePermission("contacts.view"), async (req, res, next) => {
  try {
    const query = contactQuerySchema.parse(req.query);
    res.json(await crmService.listContacts(query));
  } catch (err) {
    next(err);
  }
});

crmRouter.post(
  "/companies/:id/contacts",
  requirePermission("contacts.create"),
  async (req, res, next) => {
    try {
      const input = contactInputSchema.parse(req.body);
      res.status(201).json(await crmService.createContact(req.params.id!, input));
    } catch (err) {
      next(err);
    }
  },
);

crmRouter.patch("/contacts/:id", requirePermission("contacts.update"), async (req, res, next) => {
  try {
    const input = updateContactInputSchema.parse(req.body);
    res.json(await crmService.updateContact(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});

crmRouter.delete("/contacts/:id", requirePermission("contacts.delete"), async (req, res, next) => {
  try {
    await crmService.deleteContact(req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
