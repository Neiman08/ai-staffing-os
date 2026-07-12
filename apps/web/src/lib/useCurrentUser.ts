import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@ai-staffing-os/shared";
import { apiFetch } from "./api";

/**
 * F4.9: GET /auth/me es la única fuente de verdad de autorización real
 * — un token de Clerk válido no equivale a autorizado (ver
 * docs/F4_9_PRODUCTION_AUTH_PLAN.md §9). RequireAuth siempre espera
 * esta llamada (además de isSignedIn de Clerk) antes de renderizar el
 * portal.
 */
export function useCurrentUser(options?: { enabled?: boolean }) {
  return useQuery<CurrentUser>({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<CurrentUser>("/auth/me"),
    retry: false,
    enabled: options?.enabled ?? true,
  });
}
