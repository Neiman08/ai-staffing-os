import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static notFound(message = "Resource not found", details?: unknown) {
    return new AppError(404, "NOT_FOUND", message, details);
  }

  static forbidden(message = "Forbidden", details?: unknown) {
    return new AppError(403, "FORBIDDEN", message, details);
  }

  static unauthorized(message = "Unauthorized", details?: unknown) {
    return new AppError(401, "UNAUTHORIZED", message, details);
  }

  static badRequest(message = "Bad request", details?: unknown) {
    return new AppError(400, "BAD_REQUEST", message, details);
  }

  // F5.2: primer uso real de un 409 en el proyecto — deduplicación de
  // Candidate por email/teléfono normalizado dentro del tenant.
  static conflict(message = "Conflict", details?: unknown) {
    return new AppError(409, "CONFLICT", message, details);
  }

  static internal(message = "Internal server error", details?: unknown) {
    return new AppError(500, "INTERNAL_ERROR", message, details);
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route not found: ${req.method} ${req.path}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid request data", details: err.flatten() },
    });
    return;
  }

  // F12.7: logging estructurado con requestId real (X-Request-Id, ya en
  // la respuesta vía requestLoggingMiddleware) para poder correlacionar
  // un error de servidor con su request exacto sin cambiar la forma del
  // body que el cliente recibe -- muchos tests existentes ya verifican
  // ese body exacto, esto solo enriquece el log server-side.
  const message = err instanceof Error ? err.message : "Unknown error";
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error("unhandled_error", {
    requestId: req.id,
    method: req.method,
    path: req.path,
    errorCategory: err instanceof Error ? err.constructor.name : typeof err,
    message,
    stack,
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}
