/**
 * F12.7: logging estructurado mínimo -- una línea JSON por evento, nunca
 * texto libre. Deliberadamente sin una librería nueva (pino/winston):
 * `console.log`/`console.error` ya son exactamente lo que Render (y
 * cualquier plataforma de logs por stdout/stderr) espera consumir, y
 * este proyecto ya usaba console.log/error en todos lados -- esto solo
 * le da una forma consistente, nunca agrega una dependencia nueva ni
 * una complejidad que nadie pidió.
 *
 * Nunca loguea secretos: los campos vienen siempre de datos ya
 * conocidos como seguros (requestId, tenantId, userId, duración, status
 * code, nombre de módulo) -- ver docs/RENDER_ENVIRONMENT_VARIABLES.md "Nunca hacer"
 * para la regla equivalente de variables de entorno.
 */

export interface LogFields {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  module?: string;
  durationMs?: number;
  statusCode?: number;
  errorCategory?: string;
  [key: string]: unknown;
}

function write(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
