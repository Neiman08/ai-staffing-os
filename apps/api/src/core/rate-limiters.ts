import rateLimit from "express-rate-limit";
import { env } from "./env";

/**
 * F12.4: mismo patrón ya establecido en modules/public/router.ts (F4.8)
 * -- rateLimit() de express-rate-limit aplicado por RUTA, nunca a nivel
 * de router completo (ver el bug real documentado ahí: aplicar un
 * limiter sin path afecta a cualquier request que caiga por ese router
 * antes de coincidir con una ruta real). Por IP (default de la
 * librería), igual que el resto del proyecto -- consistente y ya
 * probado, sin la complejidad/riesgo de una key por usuario que dependa
 * del timing de AsyncLocalStorage.
 *
 * Los límites son generosos para un usuario real y restrictivos para un
 * script/bot: cada uno se eligió según el costo/impacto real de la
 * acción que protege (una misión gasta OpenAI real; un invite podría
 * usarse para spam; un export puede ser pesado de generar).
 *
 * F12.11: skip cuando NODE_ENV=test -- nunca se relaja en producción (la
 * guarda de env.ts ya impide NODE_ENV=production con AUTH_MODE=dev-bypass,
 * y "test" no es un valor alcanzable en producción real). Sin esto, la
 * corrida completa de la suite comparte un único proceso de Node, y por
 * lo tanto el mismo store en memoria de cada limiter, para TODOS los test
 * files -- un hallazgo real de la verificación de F12.11: con más de 20
 * POST /missions acumulados entre archivos, tests completamente ajenos
 * empezaban a recibir 429 según el orden de ejecución. Las pruebas de
 * "wiring" (¿está realmente montado en la ruta de producción?) verifican
 * esto ahora inspeccionando el stack real de cada router, no disparando
 * requests reales -- ver missions.test.ts, user-management.test.ts,
 * analytics/export.test.ts, payroll.test.ts.
 */
const skipInTest = () => env.NODE_ENV === "test";

export const missionLaunchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  limit: 20, // una agencia real lanza, como mucho, unas pocas misiones por día
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: "RATE_LIMITED", message: "Too many missions launched. Try again later." } },
});

export const userInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30, // onboarding real de un equipo/portal en un día no supera esto; sí frena un script de invites masivos
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: "RATE_LIMITED", message: "Too many invitations sent. Try again later." } },
});

export const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: "RATE_LIMITED", message: "Too many exports requested. Try again later." } },
});
