import { Router } from "express";
import { getTenancyContext } from "../../core/tenancy/context";
import { AppError } from "../../core/errors";
import { getBrandingConfig } from "../../core/branding";

export const brandingRouter = Router();

// Sin permiso especial: cualquier usuario autenticado del tenant puede
// ver el nombre comercial/dominio de su propia organización — no expone
// nada del CRM, es el mismo dato que ya se ve en la UI de todas formas.
brandingRouter.get("/branding", async (_req, res, next) => {
  try {
    const ctx = getTenancyContext();
    if (!ctx) throw AppError.unauthorized();
    res.json(await getBrandingConfig(ctx.tenantId));
  } catch (err) {
    next(err);
  }
});
