import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { CLERK_CONFIGURED } from "@/lib/auth-config";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { ApiError } from "@/lib/api";
import { SessionLoading } from "@/pages/auth/SessionLoading";
import { Unauthorized } from "@/pages/auth/Unauthorized";
import { Forbidden } from "@/pages/auth/Forbidden";
import { AccountDisabled } from "@/pages/auth/AccountDisabled";
import { InvitationPending } from "@/pages/auth/InvitationPending";
import { AuthTokenBridge } from "./AuthTokenBridge";

/**
 * F4.9 §9 del plan aprobado: un token válido nunca equivale a
 * autorizado por sí solo. Ambas variantes de este guard SIEMPRE llaman
 * a GET /auth/me — la única fuente real de tenantId/rol/permisos/
 * isActive — antes de renderizar el portal. La diferencia entre
 * variantes es solo si además hay una sesión de Clerk que verificar
 * primero.
 */
function renderByErrorCode(error: unknown): ReactNode {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case "USER_DISABLED":
      return <AccountDisabled />;
    case "USER_NOT_PROVISIONED":
      return <InvitationPending />;
    case "TENANT_INACTIVE":
      return <Unauthorized />;
    case "FORBIDDEN":
    case "MFA_REQUIRED":
      return <Forbidden code={code} />;
    default:
      return <Unauthorized />;
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

function DevBypassRequireAuth({ children }: { children: ReactNode }) {
  const userQuery = useCurrentUser();

  if (userQuery.isPending) return <SessionLoading />;
  if (userQuery.isError) return <>{renderByErrorCode(userQuery.error)}</>;

  return <>{children}</>;
}

// F4.9: decidido una sola vez al cargar el módulo (Vite inlinea env
// vars en build time) — nunca cambia en runtime, así que no viola las
// reglas de hooks a pesar de que las dos variantes internamente llaman
// hooks distintos.
export const RequireAuth = CLERK_CONFIGURED ? ClerkRequireAuth : DevBypassRequireAuth;
