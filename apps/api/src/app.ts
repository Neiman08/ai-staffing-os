import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { clerkMiddleware } from "@clerk/express";
import { prisma } from "@ai-staffing-os/db";
import { env } from "./core/env";
import { errorHandler, notFoundHandler } from "./core/errors";
import { getEmailProviderHealth } from "./modules/email/health";
import { requestLoggingMiddleware } from "./core/request-logging";
import { tenancyMiddleware } from "./core/tenancy/middleware";
import { authRouter } from "./modules/auth/router";
import { dashboardRouter } from "./modules/dashboard/router";
import { crmRouter } from "./modules/crm/router";
import { jobsRouter } from "./modules/jobs/router";
import { talentRouter } from "./modules/talent/router";
import { workersRouter } from "./modules/workers/router";
import { assignmentsRouter } from "./modules/assignments/router";
import { placementsRouter } from "./modules/placements/router";
import { incidentsRouter } from "./modules/incidents/router";
import { reportsRouter } from "./modules/reports/router";
import { portalRouter } from "./modules/portal/router";
import { notificationsRouter } from "./modules/notifications/router";
import { auditRouter } from "./modules/audit/router";
import { matchingRouter } from "./modules/matching/router";
import { complianceRouter } from "./modules/compliance/router";
import { payrollRouter } from "./modules/payroll/router";
import { billingRouter } from "./modules/billing/router";
import { pricingRouter } from "./modules/pricing/router";
import { agentsRouter } from "./modules/agents/router";
import { leadsRouter } from "./modules/leads/router";
import { opportunitiesRouter } from "./modules/opportunities/router";
import { followUpsRouter } from "./modules/followups/router";
import { activitiesRouter } from "./modules/activities/router";
import { revenueRouter } from "./modules/revenue/router";
import { approvalsRouter } from "./modules/approvals/router";
import { emailRouter } from "./modules/email/router";
import { prospectingRouter } from "./modules/prospecting/router";
import { aiDashboardRouter } from "./modules/ai-dashboard/router";
import { campaignsRouter } from "./modules/campaigns/router";
import { missionsRouter } from "./modules/missions/router";
import { discoveryRouter } from "./modules/discovery/router";
import { brandingRouter } from "./modules/branding/router";
import { productionReadinessRouter } from "./modules/production-readiness/router";
import { publicRouter } from "./modules/public/router";
import { authWebhookRouter } from "./modules/auth/webhook.router";
import { analyticsRouter } from "./modules/analytics/router";

/**
 * F17 (dominio propio, transición): "https://a.com, https://b.com" ->
 * ["https://a.com", "https://b.com"]. Un valor sin coma sigue
 * devolviendo un array de un solo elemento -- compatible hacia atrás
 * con cualquier configuración existente de APP_ORIGIN/MARKETING_ORIGIN.
 * Exportada (no solo inline en createApp) para poder probar el parseo
 * real sin tener que levantar un servidor completo por cada caso.
 */
export function parseOriginList(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();

  // F12.7: primero de todo -- request ID + log estructurado por
  // request, para que absolutamente ninguna respuesta (incluida una
  // rechazada por CORS o por el rate limiter) quede sin su ID de
  // correlación ni sin su línea de log.
  app.use(requestLoggingMiddleware);

  // F12.4: headers de seguridad estándar (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, sin X-Powered-By, etc.)
  // -- primero en la cadena, antes que CORS, para que apliquen a
  // absolutamente toda respuesta, incluida la de un origen rechazado.
  // contentSecurityPolicy desactivada a propósito: esto es una API JSON
  // pura, nunca sirve HTML/JS al navegador -- una CSP pensada para HTML
  // no protege nada acá y solo agregaría un header sin efecto real.
  // crossOriginResourcePolicy en "cross-origin": el default de helmet
  // ("same-origin") bloquearía las respuestas ante el fetch/XHR real del
  // frontend en Render (origen distinto por diseño, ver APP_ORIGIN) --
  // el control de origen real ya lo hace el allowlist de CORS de abajo,
  // no duplicarlo de forma más estricta acá.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // F14 (preparación de despliegue, 2026-07-19): gzip/deflate real de
  // cada respuesta -- a diferencia de apps/web/apps/marketing (sitios
  // estáticos, Render ya comprime automáticamente su CDN), este es un
  // proceso Node/Express corriendo el propio HTTP server, así que sin
  // esto NINGUNA respuesta de la API sale comprimida. Respuestas reales
  // de este proyecto que se benefician (analytics, listados grandes de
  // Company/Candidate, reportes de misión) son JSON, altamente
  // compresible. Filtro default de la librería (respeta
  // Content-Type/Accept-Encoding, nunca comprime algo ya comprimido).
  app.use(compression());

  // F4.9: reemplaza el cors() abierto de F0-F4.8 — allowlist explícito
  // armado desde env (nunca hardcodea dominios acá, ver core/env.ts
  // APP_ORIGIN/MARKETING_ORIGIN). Sin `credentials: true` a propósito:
  // el modelo de auth es Bearer token (Authorization header), nunca
  // cookies cross-origin — ver docs/F4_9_PRODUCTION_AUTH_PLAN.md §4.1/§10.
  // F4.9-D2: listo para Render sin tocar código — el dashboard de Render
  // sobreescribe APP_ORIGIN/MARKETING_ORIGIN con las URLs reales del
  // servicio (ej. https://ai-staffing-os-web.onrender.com) como
  // variables de entorno del servicio de apps/api.
  //
  // F17 (dominio propio, transición): cada variable ahora acepta una
  // lista separada por comas (ej. "https://app.dreistaff.com,
  // https://ai-staffing-os-web.onrender.com") -- una única URL sin coma
  // sigue funcionando exactamente igual que antes (split produce un
  // array de un solo elemento), así que esto es 100% compatible hacia
  // atrás. Permite tener el dominio propio y el dominio de Render de
  // Render activos al mismo tiempo durante la migración de dominio, sin
  // perder acceso técnico/rollback a las URLs viejas.
  const allowedOrigins = [env.APP_ORIGIN, env.MARKETING_ORIGIN].flatMap(parseOriginList);
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

  // F4.9: webhook de Clerk — necesita el body crudo (Buffer) para
  // verificar la firma svix, por eso se monta ANTES del
  // express.json() global de abajo (mismo principio que ya aplica
  // publicRouter de F4.8: el orden de middleware importa). Nunca lee
  // x-dev-user ni pasa por tenancyMiddleware — resuelve su propio
  // Tenant/User por clerkId/clerkOrganizationId dentro del handler.
  app.use("/api/v1/auth", authWebhookRouter);

  // F12.4: límite explícito en vez del default silencioso de Express
  // (100kb) -- mismo valor, pero ahora es una decisión documentada, no
  // un default que nadie eligió a propósito. Ningún endpoint real de
  // este proyecto necesita un body más grande (los uploads de
  // documentos son URLs vía DocumentStorageAdapter, nunca bytes crudos
  // en el body JSON).
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/v1/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      // F4.9: authMode expuesto acá (nunca info sensible, es un enum
      // público) porque el banner de dev-bypass del frontend tiene que
      // poder mostrarse ANTES de que haya sesión — health es la única
      // ruta ya pública para esto.
      res.json({ status: "ok", db: true, authMode: env.AUTH_MODE });
    } catch {
      res.status(503).json({ status: "degraded", db: false });
    }
  });

  // F12.7: liveness -- "el proceso sigue respondiendo", nunca toca la
  // DB. Un healthCheck de liveness que dependiera de la DB podría hacer
  // que la plataforma reinicie el proceso API por un problema que es de
  // la base, no del proceso -- exactamente lo que liveness NO debe
  // hacer (esa es la responsabilidad de readiness).
  app.get("/api/v1/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // F12.7: readiness -- "puedo aceptar tráfico real ahora mismo".
  // Verifica DB real + que las migraciones esperadas ya se aplicaron
  // (_prisma_migrations con al menos una fila -- un valor real, no un
  // secreto ni información interna) + que el modo de auth activo tiene
  // lo que necesita para funcionar (AUTH_MODE=clerk sin sus claves ya
  // es fatal al arrancar por el guard de env.ts, así que llegar hasta
  // acá con AUTH_MODE=clerk ya implica que están configuradas -- este
  // chequeo lo confirma en vivo, no solo al arrancar).
  app.get("/api/v1/health/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) as count FROM "_prisma_migrations"`;
      const migrationsApplied = Number(migrations[0]?.count ?? 0) > 0;
      const authConfigured = env.AUTH_MODE === "dev-bypass" || Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY);
      // F17: informativo únicamente -- nunca gatea el status 503 de este
      // endpoint. Microsoft Graph caído no debe sacar a esta instancia de
      // rotación (Render usa esta misma ruta como health check real) --
      // solo DB/migraciones/auth son motivos reales de "no listo". Sin
      // AZURE_* configurada, `configured:false` corta acá sin ninguna
      // llamada de red real (nunca agrega latencia cuando el proveedor
      // no está en uso).
      const emailProvider = await getEmailProviderHealth();

      if (!migrationsApplied || !authConfigured) {
        res.status(503).json({ status: "not_ready", db: true, migrationsApplied, authConfigured, emailProvider });
        return;
      }
      res.json({ status: "ok", db: true, migrationsApplied, authConfigured, emailProvider });
    } catch {
      res.status(503).json({ status: "not_ready", db: false });
    }
  });

  // F4.8: rutas públicas (sitio dreistaff.com) — SIN tenancyMiddleware,
  // tráfico anónimo real. Montadas antes a propósito: nunca deben pasar
  // por la resolución de identidad interna (dev-bypass/Clerk). Resuelven
  // su propio tenant vía core/public-tenant.ts.
  app.use("/api/v1", publicRouter);

  // F4.9: clerkMiddleware() verifica el JWT (firma/issuer/audience/exp)
  // y adjunta el AuthObject a `req` para que getAuth(req) lo lea en
  // ClerkAuthProvider — se monta SOLO si AUTH_MODE=clerk. Montarlo
  // incondicionalmente exigiría CLERK_SECRET_KEY incluso en dev-bypass
  // local, que no lo necesita (ver core/env.ts, la guarda ya exige las
  // claves cuando AUTH_MODE=clerk).
  if (env.AUTH_MODE === "clerk") {
    app.use(clerkMiddleware());
  }

  app.use("/api/v1", tenancyMiddleware);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/dashboard", dashboardRouter);
  app.use("/api/v1", crmRouter);
  app.use("/api/v1", jobsRouter);
  app.use("/api/v1", talentRouter);
  app.use("/api/v1", workersRouter);
  app.use("/api/v1", assignmentsRouter);
  app.use("/api/v1", placementsRouter);
  app.use("/api/v1", incidentsRouter);
  app.use("/api/v1", reportsRouter);
  app.use("/api/v1", portalRouter);
  app.use("/api/v1", notificationsRouter);
  app.use("/api/v1", auditRouter);
  app.use("/api/v1", matchingRouter);
  app.use("/api/v1", complianceRouter);
  app.use("/api/v1", payrollRouter);
  app.use("/api/v1", billingRouter);
  app.use("/api/v1", pricingRouter);
  app.use("/api/v1", agentsRouter);
  app.use("/api/v1", leadsRouter);
  app.use("/api/v1", opportunitiesRouter);
  app.use("/api/v1", followUpsRouter);
  app.use("/api/v1", activitiesRouter);
  app.use("/api/v1", revenueRouter);
  app.use("/api/v1", approvalsRouter);
  app.use("/api/v1", emailRouter);
  app.use("/api/v1", prospectingRouter);
  app.use("/api/v1", aiDashboardRouter);
  app.use("/api/v1", campaignsRouter);
  app.use("/api/v1", missionsRouter);
  app.use("/api/v1", discoveryRouter);
  app.use("/api/v1", brandingRouter);
  app.use("/api/v1", productionReadinessRouter);
  app.use("/api/v1", analyticsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
