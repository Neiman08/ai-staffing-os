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

// F5.2: bug real encontrado al correr la suite de tests de Candidates
// (>60 requests contra el mismo proceso en menos de un minuto empezaron
// a recibir 429 en endpoints internos autenticados que nunca deberían
// tocar este limiter). Causa: `publicRouter.use(readLimiter)` sin path
// aplicaba a TODO lo que entrara por este router — y como publicRouter
// se monta en `app.use("/api/v1", publicRouter)` (sin un prefijo propio
// como /api/v1/public), cualquier request a /api/v1/lo-que-sea consumía
// un cupo del mismo balde de 60/min pensado únicamente para tráfico
// anónimo del sitio de marketing, antes de caer al siguiente router
// (tenancyMiddleware → talentRouter/jobsRouter/etc.) cuando ninguna ruta
// de acá coincidía. En producción esto habría podido limitar a usuarios
// internos reales compartiendo IP/NAT con tráfico del sitio público.
// Corregido aplicando readLimiter por ruta (mismo patrón ya usado por
// writeLimiter en los POST de abajo), nunca a nivel de router completo.

publicRouter.get("/public/branding", readLimiter, async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.getPublicBranding()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/industries", readLimiter, async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.listPublicIndustries()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/job-openings", readLimiter, async (_req, res, next) => {
  try {
    res.json(await runInPublicTenantContext(() => publicService.listPublicJobOpenings()));
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/public/stats", readLimiter, async (_req, res, next) => {
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
