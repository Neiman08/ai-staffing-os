/**
 * F11.8: mismo criterio de escaping que payroll/service.ts:toCsvRow
 * (F5.7, ya en producción) -- comillas dobles alrededor de cada campo,
 * comillas internas escapadas duplicándolas. Se reimplementa acá (no se
 * importa la versión de payroll) porque esa función es privada al
 * módulo -- extraerla a shared rompería el patrón ya establecido de que
 * cada módulo de export es dueño de su propio CSV, no una dependencia
 * cruzada nueva entre payroll y analytics.
 */
export function toCsvRow(fields: Array<string | number | null>): string {
  return fields.map((f) => `"${String(f ?? "").replace(/"/g, '""')}"`).join(",");
}

export function toCsvDocument(rows: string[][]): string {
  return rows.map(toCsvRow).join("\n");
}
