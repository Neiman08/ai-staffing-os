import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

// F12.7: augmenta Request con los campos que tenancyMiddleware completa
// una vez resuelta la identidad -- lectura simple de propiedad (nunca
// AsyncLocalStorage) porque res.on("finish") dispara fuera de la
// continuación async donde vive el contexto de tenancy, y depender de
// que ALS sobreviva esa frontera es fragil. `req` es la MISMA
// referencia durante todo el ciclo de vida del request sin importar
// fronteras async, así que esto es robusto por construcción.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      resolvedTenantId?: string;
      resolvedUserId?: string;
    }
  }
}

/**
 * F12.7: primer middleware montado en app.ts -- asigna un request ID
 * real (nunca confía en un header entrante como fuente de verdad, lo
 * genera siempre acá) antes de que cualquier otra cosa pueda fallar, y
 * loguea una línea estructurada por request cuando la respuesta
 * termina (method/path/status/duración/requestId/tenantId/userId si ya
 * se resolvieron). tenancyMiddleware (montado después) es quien llena
 * req.resolvedTenantId/resolvedUserId una vez que resuelve la
 * identidad real -- este middleware nunca asume que ya existen.
 */
export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const startedAt = Date.now();

  res.on("finish", () => {
    logger.info("http_request", {
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      tenantId: req.resolvedTenantId,
      userId: req.resolvedUserId,
    });
  });

  next();
}
