import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  // F4.9: usado exclusivamente para la guarda de arranque de abajo
  // (dev-bypass nunca puede quedar activo con NODE_ENV=production) y
  // para decidir el nivel de detalle de errores/logs. No confundir con
  // PRODUCTION_MODE (F4.7.5, controla si el sistema acepta datos demo).
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_MODE: z.enum(["dev-bypass", "clerk"]).default("dev-bypass"),

  // F4.9-D1: usuario por default de DevBypassAuthProvider — configurable
  // por env en vez de hardcodeado, para que cada entorno (local, Render
  // de prueba, etc.) pueda apuntar a un usuario semilla distinto sin
  // tocar código. Nunca es auth real: sigue siendo el mismo mecanismo
  // sin verificación criptográfica de modules/auth/dev-bypass.provider.ts,
  // solo bloqueado en producción por la guarda de abajo. El reemplazo de
  // fondo sigue siendo Clerk (ver modules/auth/clerk.provider.ts, ya
  // implementado pero inactivo — se conecta cambiando AUTH_MODE=clerk).
  DEV_DEFAULT_USER_EMAIL: z.string().default("admin@titan.dev"),

  // F4.9: Clerk — proveedor de auth de producción (ver
  // docs/F4_9_PRODUCTION_AUTH_PLAN.md). Claves opcionales a nivel de
  // schema por el mismo motivo que OPENAI_API_KEY/HUNTER_API_KEY
  // arriba: en dev-bypass ninguna de estas se usa, y CI nunca debería
  // romper por su ausencia. La guarda real ("AUTH_MODE=clerk exige
  // estas claves") se aplica más abajo, al final de loadEnv().
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  CLERK_SIGN_IN_URL: z.string().default("/sign-in"),
  CLERK_SIGN_UP_URL: z.string().default("/sign-up"),
  CLERK_AFTER_SIGN_IN_URL: z.string().default("/"),
  CLERK_AFTER_SIGN_UP_URL: z.string().default("/"),

  // F4.9: allowlist de CORS — reemplaza el cors() abierto de F0-F4.8.
  // Defaults de localhost para dev; en producción se sobreescriben con
  // los dominios reales (https://app.dreistaff.com, etc.) por env,
  // nunca hardcodeados acá.
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  MARKETING_ORIGIN: z.string().default("http://localhost:5174"),
  API_ORIGIN: z.string().default("http://localhost:4000"),
  // F2: optional at the env-validation level so F0/F1 environments (CI,
  // tests that never invoke the Sales Agent) don't break. Enforced instead
  // at the point of actual use (task-runner refuses to call OpenAI without it).
  OPENAI_API_KEY: z.string().optional(),
  // F4.5: proveedor comercial primario del Discovery Agent — opcional acá
  // por el mismo motivo que OPENAI_API_KEY. Sin configurar, discoverCompaniesTool
  // usa únicamente Overpass (gratis) como fuente.
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  // F4.6: proveedor primario del Contact Intelligence Agent — mismo
  // patrón, opcional acá. Sin configurar, findContactsTool no encuentra
  // nada (nunca inventa un contacto para compensar).
  PEOPLEDATALABS_API_KEY: z.string().optional(),
  // F4.7: mismo vendor para email discovery Y verification (Hunter.io) —
  // opcional acá, mismo motivo. Sin configurar, findEmailTool solo usa
  // Website Intelligence (gratis, sin proveedor).
  HUNTER_API_KEY: z.string().optional(),
  // F4.7 §1.2: contacto real del bot en el User-Agent de Website
  // Intelligence — opcional a propósito (nunca hardcodea una marca
  // todavía no decidida). Sin configurar, el User-Agent se envía sin
  // cláusula de contacto en vez de inventar una.
  WEBSITE_INTELLIGENCE_CONTACT_EMAIL: z.string().optional(),

  // Branding — decisión real del PO (marca DreiStaff / dominio
  // dreistaff.com, entidad legal Data More LLC). Estos 4 SÍ tienen
  // default real porque ya están decididos; siguen siendo overridable
  // por env (nunca hardcodeados en código/UI fuera de esto) y por
  // Tenant.settings (ver core/branding.ts) para el caso multi-tenant/
  // white-label. Nunca se referencia "DreiStaff"/"dreistaff.com" en
  // ningún otro archivo del repo — todo pasa por acá.
  BUSINESS_LEGAL_NAME: z.string().default("Data More LLC"),
  BUSINESS_BRAND_NAME: z.string().default("DreiStaff"),
  BUSINESS_DOMAIN: z.string().default("dreistaff.com"),
  APP_DOMAIN: z.string().default("app.dreistaff.com"),
  OUTREACH_FROM_NAME: z.string().default("DreiStaff"),
  // Deliberadamente SIN default y opcionales — el PO fue explícito: "no
  // inventes todavía correo de envío definitivo, dirección postal,
  // Reply-To". Quedan null hasta que el PO los configure a mano; ningún
  // código de F4.7 puede enviar un email real mientras falten (ver
  // docs/F4_7_EMAIL_INTELLIGENCE_PLAN.md, Bloqueantes).
  OUTREACH_FROM_EMAIL: z.string().optional(),
  OUTREACH_REPLY_TO: z.string().optional(),
  BUSINESS_POSTAL_ADDRESS: z.string().optional(),

  // F17: Microsoft Graph (envío real de email, OAuth2 Client Credentials
  // -- app-only, nunca /me/sendMail). Las 4 opcionales acá por el mismo
  // motivo que el resto de proveedores externos (CI/dev nunca deben
  // romper por su ausencia) -- la guarda real ("las 4 juntas o ninguna",
  // y MAIL_FROM debe ser del dominio propio) vive más abajo, al final de
  // loadEnv(), mismo criterio que la guarda de Clerk. Ver
  // modules/email/microsoft-graph.ts / modules/email/sender-profiles.ts.
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  // Remitente GENERAL (contacto institucional/formularios públicos) --
  // nunca el remitente comercial, que está hardcodeado a propósito en
  // sender-profiles.ts (sales@<BUSINESS_DOMAIN>, nunca configurable por
  // env -- "Valida que MAIL_FROM no permita remitentes arbitrarios" del
  // pedido real). Debe ser del dominio propio (BUSINESS_DOMAIN) cuando
  // esté configurado -- validado más abajo.
  MAIL_FROM: z.string().optional(),

  // F4.7.5 §2: Production Mode — default false (permite datos demo,
  // seeds, regresión). NUNCA se activa desde este commit — queda
  // preparado, a la espera de aprobación explícita del PO antes de
  // pasar a true en cualquier entorno real. Ver core/production-mode.ts.
  PRODUCTION_MODE: z.coerce.boolean().default(false),

  // F4.8: qué Tenant sirve el sitio público (dreistaff.com) — este
  // pilot es de un solo tenant real ("titan", el mismo de siempre en
  // seed.ts), pero el valor sigue siendo configurable por env, nunca
  // hardcodeado en el código de las rutas públicas. Ver core/public-tenant.ts.
  PUBLIC_TENANT_SLUG: z.string().default("titan"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const data = parsed.data;

  // F4.9: la regla no-negociable del PO — dev-bypass confía ciegamente
  // en un header sin verificación criptográfica (ver
  // modules/auth/dev-bypass.provider.ts); si esto llegara a quedar
  // activo en producción cualquiera podría autenticarse como cualquier
  // usuario con solo mandar `x-dev-user: admin@titan.dev`. Falla rápido
  // y ruidoso al arrancar, nunca un bug silencioso de seguridad.
  if (data.NODE_ENV === "production" && data.AUTH_MODE === "dev-bypass") {
    console.error(
      "FATAL: AUTH_MODE=dev-bypass is not allowed when NODE_ENV=production. " +
        "Set AUTH_MODE=clerk (with CLERK_SECRET_KEY/CLERK_PUBLISHABLE_KEY configured) before deploying.",
    );
    process.exit(1);
  }

  // F4.9: si se eligió Clerk como proveedor, sus dos claves centrales
  // dejan de ser opcionales — un ClerkAuthProvider sin ellas fallaría
  // de forma impredecible en cada request en vez de al arrancar.
  if (data.AUTH_MODE === "clerk" && (!data.CLERK_SECRET_KEY || !data.CLERK_PUBLISHABLE_KEY)) {
    console.error(
      "FATAL: AUTH_MODE=clerk requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY to be set.",
    );
    process.exit(1);
  }

  // F17: Microsoft Graph -- las 3 credenciales de Client Credentials
  // deben venir juntas o ninguna. Una configuración parcial (ej.
  // AZURE_CLIENT_ID sin AZURE_CLIENT_SECRET) fallaría de forma
  // impredecible en el primer envío real en vez de al arrancar -- mismo
  // criterio que la guarda de Clerk arriba.
  const azureVars = [data.AZURE_TENANT_ID, data.AZURE_CLIENT_ID, data.AZURE_CLIENT_SECRET];
  const azureConfiguredCount = azureVars.filter((v) => !!v).length;
  if (azureConfiguredCount > 0 && azureConfiguredCount < azureVars.length) {
    console.error(
      "FATAL: Microsoft Graph requires AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET together — " +
        "found a partial configuration. Set all three, or none.",
    );
    process.exit(1);
  }
  // MAIL_FROM (remitente GENERAL) nunca puede ser un dominio ajeno --
  // este backend jamás debe poder mandar "en nombre de" un dominio que
  // no controlamos. El remitente COMERCIAL (sales@) ni siquiera lee esta
  // variable -- está hardcodeado en sender-profiles.ts, ver ese archivo.
  if (data.MAIL_FROM && !data.MAIL_FROM.toLowerCase().endsWith(`@${data.BUSINESS_DOMAIN.toLowerCase()}`)) {
    console.error(
      `FATAL: MAIL_FROM ("${data.MAIL_FROM}") must be an address on BUSINESS_DOMAIN ("${data.BUSINESS_DOMAIN}") — ` +
        "arbitrary sender domains are not allowed.",
    );
    process.exit(1);
  }

  return data;
}

export const env = loadEnv();
