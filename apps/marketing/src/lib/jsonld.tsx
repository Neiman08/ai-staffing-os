import { useEffect } from "react";
import { usePublicBranding } from "./branding";

const SCRIPT_ID = "jsonld-organization";

/**
 * F4.8: schema.org Organization — construido solo con datos reales de
 * GET /api/v1/public/branding (nunca "DreiStaff"/dominio hardcodeados
 * acá). Se monta una vez que la marca real resuelve; en la primera
 * carga, antes de eso, no inyecta nada en vez de inventar un placeholder.
 */
export function useOrganizationJsonLd(): void {
  const branding = usePublicBranding();

  useEffect(() => {
    if (!branding) return;

    const data = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: branding.brandName,
      legalName: branding.legalName,
      url: `https://${branding.domain}`,
      ...(branding.businessPostalAddress ? { address: branding.businessPostalAddress } : {}),
    };

    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.type = "application/ld+json";
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);

    return () => {
      script?.remove();
    };
  }, [branding]);
}
