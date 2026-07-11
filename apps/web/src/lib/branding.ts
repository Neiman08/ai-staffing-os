import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BrandingConfig } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";

// Branding centralizado — el frontend nunca hardcodea el nombre
// comercial ni el dominio, siempre los pide a GET /branding (ver
// apps/api/src/core/branding.ts, única fuente de verdad). Mientras
// carga, `brandName` es null — los consumidores deciden el fallback
// (nunca un nombre inventado, nunca un parpadeo con la marca vieja).
export function useBranding() {
  return useQuery({
    queryKey: ["branding"],
    queryFn: () => apiFetch<BrandingConfig>("/branding"),
    staleTime: 5 * 60 * 1000, // no cambia seguido, evita refetch en cada navegación
  });
}

/** Sincroniza <title> con la marca real una vez que se conoce — nunca deja un nombre hardcodeado en index.html más allá del placeholder inicial. */
export function useDocumentTitleFromBranding(brandName: string | undefined, suffix?: string): void {
  useEffect(() => {
    if (!brandName) return;
    document.title = suffix ? `${brandName} — ${suffix}` : brandName;
  }, [brandName, suffix]);
}
