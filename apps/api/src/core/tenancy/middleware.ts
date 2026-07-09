import type { NextFunction, Request, Response } from "express";
import { env } from "../env";
import { AppError } from "../errors";
import { DevBypassAuthProvider } from "../../modules/auth/dev-bypass.provider";
import type { AuthProvider } from "../../modules/auth/auth-provider";
import { runWithTenancyContext } from "./context";

function resolveAuthProvider(): AuthProvider {
  switch (env.AUTH_MODE) {
    case "dev-bypass":
      return new DevBypassAuthProvider();
    case "clerk":
      throw new Error("AUTH_MODE=clerk is not implemented until F1");
  }
}

const authProvider = resolveAuthProvider();

export async function tenancyMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const identity = await authProvider.resolveIdentity(req);
    runWithTenancyContext(identity, () => next());
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(AppError.unauthorized("Failed to resolve identity"));
  }
}
