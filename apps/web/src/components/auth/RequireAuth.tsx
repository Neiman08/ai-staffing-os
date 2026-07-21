import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { CLERK_CONFIGURED } from "@/lib/auth-config";
import { isMockAuthenticated } from "@/lib/mock-auth";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { ApiError } from "@/lib/api";
import { SessionLoading } from "@/pages/auth/SessionLoading";
import { Unauthorized } from "@/pages/auth/Unauthorized";
import { Forbidden } from "@/pages/auth/Forbidden";
import { AccountDisabled } from "@/pages/auth/AccountDisabled";
import { InvitationPending } from "@/pages/auth/InvitationPending";
import { ConnectionError } from "@/pages/auth/ConnectionError";
import { AuthTokenBridge } from "./AuthTokenBridge";

/**
 * F4.9 §9 del plan aprobado: un token válido nunca equivale a
 * autorizado por sí solo. Ambas variantes de este guard SIEMPRE llaman
 * a GET /auth/me — la única fuente real de tenantId/rol/permisos/
 * isActive — antes de renderizar el portal. La diferencia entre
 * variantes es solo si además hay una sesión de Clerk que verificar
 * primero.
 *
 * F14 (hallazgo real, primer deploy a Render): "error instanceof
 * ApiError" puede ser falso por dos motivos MUY distintos, que antes
 * caían los dos en el mismo "Session required" genérico -- (1) fetch()
 * mismo tiró (red/CORS bloqueado antes de cualquier respuesta), o (2)
 * hubo una respuesta 200 pero no era el JSON de error esperado (ej.
 * VITE_API_URL sin configurar en el build del frontend: un fetch
 * relativo a "/api/v1/auth/me" le pega al propio sitio estático, que
 * por la regla de rewrite de la SPA devuelve el index.html -- res.json()
 * revienta con un SyntaxError). Ninguno de los dos es "no estás
 * autorizado", así que ahora van a ConnectionError, nunca a Unauthorized/
 * "sign in" (que además no tiene sentido mostrar en dev-bypass, donde
 * no existe ningún flujo de sign-in). Un ApiError con code=UNAUTHORIZED
 * (dev-bypass real, ej. "no active user found for email ...") ahora
 * también pasa su `message` real a Unauthorized -- diagnóstico
 * accionable en vez de una pantalla ambigua.
 */
function renderByErrorCode(error: unknown): ReactNode {
  if (!(error instanceof ApiError)) {
    return <ConnectionError />;
  }
  switch (error.code) {
    case "USER_DISABLED":
      return <AccountDisabled />;
    case "USER_NOT_PROVISIONED":
      return <InvitationPending />;
    case "TENANT_INACTIVE":
      return <Unauthorized message={CLERK_CONFIGURED ? undefined : error.message} />;
    case "FORBIDDEN":
    case "MFA_REQUIRED":
      return <Forbidden code={error.code} />;
    default:
      return <Unauthorized message={CLERK_CONFIGURED ? undefined : error.message} />;
  }
}

function ClerkRequireAuth({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const userQuery = useCurrentUser({ enabled: isSignedIn === true });

  if (!isLoaded) return <SessionLoading />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  if (userQuery.isPending) return <SessionLoading />;
  if (userQuery.isError) return <>{renderByErrorCode(userQuery.error)}</>;

  return (
    <>
      <AuthTokenBridge />
      {children}
    </>
  );
}

/**
 * TEMPORAL -- ver lib/mock-auth.ts. Antes de resolver la identidad real
 * de dev-bypass, exige haber pasado por la pantalla de login mock (una
 * sola vez por sesión de pestaña) -- pedido explícito: "no quiero que
 * entre directamente". No cambia en absoluto la identidad que
 * DevBypassRequireAuth ya resolvía (sigue siendo DEV_DEFAULT_USER_EMAIL
 * del backend); solo antepone un gate de UI. Eliminar este chequeo (y
 * MockLogin.tsx/mock-auth.ts) al integrar el sistema de auth definitivo.
 */
function DevBypassRequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const userQuery = useCurrentUser({ enabled: isMockAuthenticated() });

  if (!isMockAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (userQuery.isPending) return <SessionLoading />;
  if (userQuery.isError) return <>{renderByErrorCode(userQuery.error)}</>;

  return <>{children}</>;
}

// F4.9: decidido una sola vez al cargar el módulo (Vite inlinea env
// vars en build time) — nunca cambia en runtime, así que no viola las
// reglas de hooks a pesar de que las dos variantes internamente llaman
// hooks distintos.
export const RequireAuth = CLERK_CONFIGURED ? ClerkRequireAuth : DevBypassRequireAuth;
