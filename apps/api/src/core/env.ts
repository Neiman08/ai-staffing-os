import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  AUTH_MODE: z.enum(["dev-bypass", "clerk"]).default("dev-bypass"),
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
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
