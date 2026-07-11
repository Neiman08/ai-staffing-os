import { env } from "./env";
import { AppError } from "./errors";

/**
 * F4.7.5 §2: Production Mode — apagado por defecto (`PRODUCTION_MODE=false`).
 *
 * false (default, hoy): permite datos demo, permite correr seed.ts,
 * permite regresión (volver a sembrar/probar libremente).
 *
 * true (todavía nunca activado en este commit): prohíbe crear datos
 * demo, oculta datos demo en las vistas comerciales sin excepción
 * (ignora el toggle "Solo datos reales" — deja de ser opcional),
 * impide que seed.ts corra (ver packages/db/prisma/seed.ts,
 * assertSeedAllowed), e impide cualquier fixture/contacto/empresa
 * ficticia que un endpoint pudiera intentar crear.
 *
 * Nadie activa esto en este commit — F4.7.5 solo deja la lógica lista
 * y probada, la decisión de pasar a true es exclusiva del PO.
 */
export function isProductionMode(): boolean {
  return env.PRODUCTION_MODE;
}

/** Usar en cualquier código que cree datos demo/fixture — nunca se llama desde un flujo de datos reales. */
export function assertDemoDataAllowed(action: string): void {
  if (env.PRODUCTION_MODE) {
    throw new AppError(403, "PRODUCTION_MODE_ACTIVE", `${action} no está permitido con PRODUCTION_MODE=true.`);
  }
}
