import { Router } from "express";
import rateLimit from "express-rate-limit";
import { publicApplicationInputSchema, publicLeadInputSchema } from "@ai-staffing-os/shared";
import { runInPublicTenantContext } from "../../core/public-tenant";
import * as publicService from "./service";

export const publicRouter = Router();

// F4.8: primera vez que el backend expone algo a tráfico anónimo de
// internet — rate limit obligatorio en los 3 endpoints de escritura
// (GET de solo lectura no lo necesita tanto, pero igual se protege con
// un límite más generoso contra scraping abusivo).
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10, // 10 envíos de formulario por IP cada 15 min — generoso para un visitante real, restrictivo para un bot
  standardHeaders: true,
  legacyHeaders: false,
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

publicRouter.use(readLimiter);

publicRouter.get("/public/branding", async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.getPublicBranding()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/industries", async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.listPublicIndustries()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/job-openings", async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.listPublicJobOpenings()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/stats", async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.getPublicStats()));
  } catch (err) {
    next(err);
  }
});

publicRouter.post("/public/contact", writeLimiter, async (req, res, next) => {
  try {
    const input = publicLeadInputSchema.parse(req.body);
    const result = await runInPublicTenantContext(() =>
      publicService.submitPublicLead({ ...input, companyName: input.companyName ?? null, industryName: input.industryName ?? null, state: input.state ?? null, city: input.city ?? null, phone: input.phone ?? null, message: input.message ?? null, source: "website-contact-form" }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

publicRouter.post("/public/request-talent", writeLimiter, async (req, res, next) => {
  try {
    const input = publicLeadInputSchema.parse(req.body);
    const result = await runInPublicTenantContext(() =>
      publicService.submitPublicLead({ ...input, companyName: input.companyName ?? null, industryName: input.industryName ?? null, state: input.state ?? null, city: input.city ?? null, phone: input.phone ?? null, message: input.message ?? null, source: "website-request-talent" }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

publicRouter.post("/public/apply", writeLimiter, async (req, res, next) => {
  try {
    const input = publicApplicationInputSchema.parse(req.body);
    const result = await runInPublicTenantContext(() =>
      publicService.submitPublicApplication({
        ...input,
        phone: input.phone ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        yearsExperience: input.yearsExperience ?? null,
        categoryName: input.categoryName ?? null,
        resumeUrl: input.resumeUrl ?? null,
      }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
