import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { setAuthTokenGetter } from "@/lib/auth-token";

/**
 * F4.9: único puente entre useAuth().getToken() (hook, solo disponible
 * dentro de <ClerkProvider>) y apiFetch (función plana). Se monta una
 * vez dentro del árbol de ClerkProvider; nunca renderiza nada.
 */
export function AuthTokenBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);

  return null;
}
