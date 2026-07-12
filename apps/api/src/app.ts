import express from "express";
import cors from "cors";
import { prisma } from "@ai-staffing-os/db";
import { env } from "./core/env";
import { errorHandler, notFoundHandler } from "./core/errors";
import { tenancyMiddleware } from "./core/tenancy/middleware";
import { authRouter } from "./modules/auth/router";
import { dashboardRouter } from "./modules/dashboard/router";
import { crmRouter } from "./modules/crm/router";
import { jobsRouter } from "./modules/jobs/router";
import { talentRouter } from "./modules/talent/router";
import { complianceRouter } from "./modules/compliance/router";
import { payrollRouter } from "./modules/payroll/router";
import { pricingRouter } from "./modules/pricing/router";
import { agentsRouter } from "./modules/agents/router";
import { leadsRouter } from "./modules/leads/router";
import { opportunitiesRouter } from "./modules/opportunities/router";
import { followUpsRouter } from "./modules/followups/router";
import { activitiesRouter } from "./modules/activities/router";
import { revenueRouter } from "./modules/revenue/router";
import { approvalsRouter } from "./modules/approvals/router";
import { prospectingRouter } from "./modules/prospecting/router";
import { aiDashboardRouter } from "./modules/ai-dashboard/router";
import { campaignsRouter } from "./modules/campaigns/router";
import { missionsRouter } from "./modules/missions/router";
import { discoveryRouter } from "./modules/discovery/router";
import { brandingRouter } from "./modules/branding/router";
import { productionReadinessRouter } from "./modules/production-readiness/router";
import { publicRouter } from "./modules/public/router";

export function createApp() {
  const app = express();

  // F4.9: reemplaza el cors() abierto de F0-F4.8 — allowlist explícito
  // armado desde env (nunca hardcodea dominios acá, ver core/env.ts
  // APP_ORIGIN/MARKETING_ORIGIN). Sin `credentials: true` a propósito:
  // el modelo de auth es Bearer token (Authorization header), nunca
  // cookies cross-origin — ver docs/F4_9_PRODUCTION_AUTH_PLAN.md §4.1/§10.
  const allowedOrigins = [env.APP_ORIGIN, env.MARKETING_ORIGIN];
  app.use(
    cors({
      origin(origin, callback) {
        // Sin header Origin (curl, server-to-server, health checks) — se
        // permite; no es un contexto de navegador donde CORS aplique.
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
    }),
  );
  app.use(express.json());

  app.get("/api/v1/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: true });
    } catch {
      res.status(503).json({ status: "degraded", db: false });
    }
  });

  // F4.8: rutas públicas (sitio dreistaff.com) — SIN tenancyMiddleware,
  // tráfico anónimo real. Montadas antes a propósito: nunca deben pasar
  // por la resolución de identidad interna (dev-bypass/Clerk). Resuelven
  // su propio tenant vía core/public-tenant.ts.
  app.use("/api/v1", publicRouter);

  app.use("/api/v1", tenancyMiddleware);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/dashboard", dashboardRouter);
  app.use("/api/v1", crmRouter);
  app.use("/api/v1", jobsRouter);
  app.use("/api/v1", talentRouter);
  app.use("/api/v1", complianceRouter);
  app.use("/api/v1", payrollRouter);
  app.use("/api/v1", pricingRouter);
  app.use("/api/v1", agentsRouter);
  app.use("/api/v1", leadsRouter);
  app.use("/api/v1", opportunitiesRouter);
  app.use("/api/v1", followUpsRouter);
  app.use("/api/v1", activitiesRouter);
  app.use("/api/v1", revenueRouter);
  app.use("/api/v1", approvalsRouter);
  app.use("/api/v1", prospectingRouter);
  app.use("/api/v1", aiDashboardRouter);
  app.use("/api/v1", campaignsRouter);
  app.use("/api/v1", missionsRouter);
  app.use("/api/v1", discoveryRouter);
  app.use("/api/v1", brandingRouter);
  app.use("/api/v1", productionReadinessRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
