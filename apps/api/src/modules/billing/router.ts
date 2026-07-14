import { Router } from "express";
import { createInvoiceInputSchema, createPaymentInputSchema, invoiceQuerySchema, updateInvoiceStatusInputSchema } from "@ai-staffing-os/shared";
import { requirePermission } from "../../core/rbac/require-permission";
import { AppError } from "../../core/errors";
import * as billingService from "./service";

export const billingRouter = Router();

billingRouter.get("/invoices", requirePermission("invoices.view"), async (req, res, next) => {
  try {
    const query = invoiceQuerySchema.parse(req.query);
    res.json(await billingService.listInvoices(query));
  } catch (err) {
    next(err);
  }
});

billingRouter.get("/invoices/:id", requirePermission("invoices.view"), async (req, res, next) => {
  try {
    res.json(await billingService.getInvoiceDetail(req.params.id!));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/invoices", requirePermission("invoices.create"), async (req, res, next) => {
  try {
    const input = createInvoiceInputSchema.parse(req.body);
    res.status(201).json(await billingService.createInvoice(input));
  } catch (err) {
    next(err);
  }
});

// F5.8 (plan §10.1, decisión previa F4.9 §6): la transición manual
// DRAFT->SENT exige invoices.send (permiso especial sujeto a MFA), no
// invoices.update a secas — mismo criterio que payroll.approve vs
// payrollRuns.update en F5.7. VOID sí usa invoices.update. Se rechaza
// acá explícitamente un intento de ->SENT por esta ruta genérica, para
// que no sea un bypass del permiso especial.
billingRouter.patch("/invoices/:id/status", requirePermission("invoices.update"), async (req, res, next) => {
  try {
    const input = updateInvoiceStatusInputSchema.parse(req.body);
    if (input.status === "SENT") {
      throw AppError.forbidden("Use POST /invoices/:id/send to send an invoice (requires invoices.send)");
    }
    res.json(await billingService.updateInvoiceStatus(req.params.id!, input.status));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/invoices/:id/send", requirePermission("invoices.send"), async (req, res, next) => {
  try {
    res.json(await billingService.updateInvoiceStatus(req.params.id!, "SENT"));
  } catch (err) {
    next(err);
  }
});

billingRouter.post("/invoices/:id/payments", requirePermission("invoices.update"), async (req, res, next) => {
  try {
    const input = createPaymentInputSchema.parse(req.body);
    res.status(201).json(await billingService.createPayment(req.params.id!, input));
  } catch (err) {
    next(err);
  }
});
