/**
 * ============================================================
 * TEMPORAL -- autenticación mock local, pendiente de reemplazo.
 * ============================================================
 * Pedido explícito: una pantalla de login real para poder probar la
 * app sin entrar directo, SIN integrar Clerk/Microsoft/Auth0/Firebase
 * todavía. Esta capa es puramente client-side: valida el email/password
 * contra una única cuenta de prueba hardcodeada, y solo gatea si se
 * MUESTRA el shell de la app o la pantalla de login -- nunca toca el
 * backend ni sustituye la identidad real que ya resuelve dev-bypass
 * (ver RequireAuth.tsx). Sin header `x-dev-user` enviado, el backend ya
 * resuelve DEV_DEFAULT_USER_EMAIL (admin@titan.dev, ver
 * apps/api/src/core/env.ts) como hoy -- este mock no cambia esa
 * identidad ni requiere ninguna fila nueva en la base de datos.
 *
 * Reemplazar por el sistema de auth definitivo: eliminar este archivo,
 * MockLogin.tsx, y el bloque `if (!CLERK_CONFIGURED && !isMockAuthenticated())`
 * en RequireAuth.tsx.
 */

const STORAGE_KEY = "dreistaff_mock_auth";

const MOCK_CREDENTIALS = {
  email: "admin@dreistaff.com",
  password: "DreiStaff2026!",
} as const;

export function isMockAuthenticated(): boolean {
  return sessionStorage.getItem(STORAGE_KEY) === "true";
}

export function mockLogin(email: string, password: string): boolean {
  const ok = email.trim().toLowerCase() === MOCK_CREDENTIALS.email && password === MOCK_CREDENTIALS.password;
  if (ok) sessionStorage.setItem(STORAGE_KEY, "true");
  return ok;
}

export function mockLogout(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
