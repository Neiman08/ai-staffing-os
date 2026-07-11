import { useEffect } from "react";
import { usePublicBranding } from "./branding";

export interface SeoProps {
  title: string;
  description: string;
  path: string; // ej. "/employers" — para canonical/OG url
}

function setMeta(name: string, content: string, attr: "name" | "property" = "name"): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setCanonical(href: string): void {
  let el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    document.head.appendChild(el);
  }
  el.href = href;
}

/**
 * F4.8: SEO por página — sin react-helmet (una dependencia menos para
 * un sitio que ya se decidió mantener liviano), un hook chico que
 * escribe directo al <head> real. document.title/meta quedan
 * actualizados apenas la marca real carga (usePublicBranding) — nunca
 * se muestra "DreiStaff" hardcodeado acá, se arma con el brandName real.
 */
export function useSeo({ title, description, path }: SeoProps): void {
  const branding = usePublicBranding();

  useEffect(() => {
    const brandName = branding?.brandName;
    const fullTitle = brandName ? `${title} | ${brandName}` : title;
    document.title = fullTitle;
    setMeta("description", description);
    setMeta("og:title", fullTitle, "property");
    setMeta("og:description", description, "property");
    setMeta("og:type", "website", "property");
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", fullTitle);
    setMeta("twitter:description", description);

    if (branding?.domain) {
      const url = `https://${branding.domain}${path === "/" ? "" : path}`;
      setCanonical(url);
      setMeta("og:url", url, "property");
    }
  }, [title, description, path, branding]);
}
