import { ShieldCheck } from "lucide-react";

/**
 * F4.8A: bloque de confianza bajo los CTA del hero — a propósito NUNCA
 * una cifra inventada ("200+ companies", "5K+ candidates"). Los
 * números reales viven exclusivamente en <StatsBar/>, que los pide a
 * GET /public/stats y se oculta a sí misma si no hay datos todavía. Acá
 * solo un mensaje honesto sobre las industrias que realmente cubrimos.
 */
export function TrustStrip() {
  return (
    <div className="mt-8 flex items-center gap-3 text-sm text-ink-foreground/60">
      <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
      <span>Trusted by employers across Data Centers, Manufacturing, Construction, and Warehouse operations.</span>
    </div>
  );
}
