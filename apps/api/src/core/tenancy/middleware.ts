import type { NextFunction, Request, Response } from "express";
import { env } from "../env";
import { AppError } from "../errors";
import { DevBypassAuthProvider } from "../../modules/auth/dev-bypass.provider";
import { ClerkAuthProvider } from "../../modules/auth/clerk.provider";
import type { AuthProvider } from "../../modules/auth/auth-provider";
import { runWithTenancyContext } from "./context";

function resolveAuthProvider(): AuthProvider {
  switch (env.AUTH_MODE) {
    case "dev-bypass":
      return new DevBypassAuthProvider();
    case "clerk":
      return new ClerkAuthProvider();
  }
}

const authProvider = resolveAuthProvider();

export async function tenancyMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const identity = await authProvider.resolveIdentity(req);
    // F12.7: copia simple sobre `req` (misma referencia durante todo el
    // ciclo de vida del request) para que requestLoggingMiddleware pueda
    // leerla en res.on("finish"), que dispara fuera de la continuación
    // async donde vive runWithTenancyContext -- ver request-logging.ts.
    req.resolvedTenantId = identity.tenantId;
    req.resolvedUserId = identity.userId;
    runWithTenancyContext(identity, () => next());
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(AppError.unauthorized("Failed to resolve identity"));
  }
}
