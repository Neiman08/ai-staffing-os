import rateLimit from "express-rate-limit";

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
 */

export const missionLaunchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  limit: 20, // una agencia real lanza, como mucho, unas pocas misiones por día -- 20/hora es generoso incluso para pruebas activas
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many missions launched. Try again later." } },
});

export const userInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30, // onboarding real de un equipo/portal en un día no supera esto; sí frena un script de invites masivos
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many invitations sent. Try again later." } },
});

export const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many exports requested. Try again later." } },
});
