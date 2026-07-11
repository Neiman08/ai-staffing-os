import { useEffect, useState } from "react";
import type { BrandingConfig } from "@ai-staffing-os/shared";
import { publicApiFetch } from "./api";

// F4.8: el sitio público nunca hardcodea "DreiStaff"/"dreistaff.com" —
// siempre lo pide a GET /api/v1/public/branding (variante pública del
// mismo endpoint que ya usa el portal privado, ver
// apps/api/src/modules/public/router.ts). Sin TanStack Query a
// propósito — el sitio de marketing es liviano y desacoplado del CRM,
// no necesita su maquinaria de cache/reintentos.
let cached: BrandingConfig | null = null;
// Header, Footer, y useSeo() de cada página montan este hook casi
// simultáneamente en la carga inicial — sin esta guarda de "in-flight"
// disparan 3 fetches duplicados contra un endpoint con rate limit.
let inflight: Promise<BrandingConfig> | null = null;

export function usePublicBranding(): BrandingConfig | null {
  const [branding, setBranding] = useState<BrandingConfig | null>(cached);

  useEffect(() => {
    if (cached) return;
    if (!inflight) {
      inflight = publicApiFetch<BrandingConfig>("/branding").finally(() => {
        inflight = null;
      });
    }
    inflight
      .then((data) => {
        cached = data;
        setBranding(data);
      })
      .catch(() => {
        // Sin branding real disponible, la UI usa sus propios fallbacks
        // neutros (nunca inventa un nombre) — ver componentes que
        // consumen este hook.
      });
  }, []);

  return branding;
}
