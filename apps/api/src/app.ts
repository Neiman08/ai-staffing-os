import express from "express";
import cors from "cors";
import { prisma } from "@ai-staffing-os/db";
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

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/api/v1/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: true });
    } catch {
      res.status(503).json({ status: "degraded", db: false });
    }
  });

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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
