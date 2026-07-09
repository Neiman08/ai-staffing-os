import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  AUTH_MODE: z.enum(["dev-bypass", "clerk"]).default("dev-bypass"),
  // F2: optional at the env-validation level so F0/F1 environments (CI,
  // tests that never invoke the Sales Agent) don't break. Enforced instead
  // at the point of actual use (task-runner refuses to call OpenAI without it).
  OPENAI_API_KEY: z.string().optional(),
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
