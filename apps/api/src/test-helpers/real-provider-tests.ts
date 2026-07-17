/**
 * Hallazgo de auditoría F7.7: varios tests de integración (F4-F7)
 * llamaban a un proveedor externo pago (Google Places, People Data
 * Labs, Hunter.io) de forma incondicional en cada corrida de
 * `pnpm test` -- violando la regla explícita "los tests unitarios/
 * integración deben tener CERO llamadas reales" y consumiendo
 * presupuesto real en cada una de las ~40+ subfases restantes que
 * exigen "ejecutar suite completa". Este gate los desactiva por
 * default; se activan deliberadamente con RUN_REAL_PROVIDER_TESTS=1
 * cuando de verdad haga falta ejercitar la integración real end-to-end
 * (nunca automáticamente, nunca en CI).
 */
export const REAL_PROVIDER_TESTS_ENABLED = process.env.RUN_REAL_PROVIDER_TESTS === "1";

export const REAL_PROVIDER_TEST_SKIP_REASON =
  "llamada real a proveedor externo pago -- gateada detrás de RUN_REAL_PROVIDER_TESTS=1 (ver test-helpers/real-provider-tests.ts)";
