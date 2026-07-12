import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface HealthResponse {
  status: string;
  db: boolean;
  authMode: "dev-bypass" | "clerk";
}

/**
 * F4.9 §7: "mostrar banner visible en desarrollo" — /health es pública
 * (sin auth), así que este chequeo funciona incluso antes de que exista
 * cualquier sesión. Nunca oculto silenciosamente: si authMode es
 * dev-bypass, siempre se muestra, sin excepción ni flag para apagarlo.
 */
export function DevBanner() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<HealthResponse>("/health"),
    staleTime: 60_000,
  });

  if (data?.authMode !== "dev-bypass") return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-medium text-amber-950">
      <AlertTriangle className="h-3.5 w-3.5" />
      DEV-BYPASS auth is active — this build has no real session verification. Never use in production.
    </div>
  );
}
