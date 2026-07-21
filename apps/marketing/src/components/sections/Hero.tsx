import { ArrowRight, ChevronDown } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { Photo } from "@/components/ui/Photo";
import { TrustStrip } from "./TrustStrip";
import { PHOTOS } from "@/lib/photos";

/**
 * F4.8B (rediseño): fondo fotográfico full-bleed a todo el ancho de la
 * sección (antes: foto acotada a una tarjeta 4:5 en la mitad derecha,
 * se veía pequeña/recortada en pantallas anchas). El texto vive sobre
 * un degradado oscuro (izquierda→derecha + abajo→arriba) para
 * legibilidad AA real sobre cualquier zona de la foto, mismo criterio
 * visual que Deel/Rippling: una sola fotografía grande transmitiendo
 * escala, nunca una composición dividida que la reduce.
 *
 * F4.8B (segunda pasada, pedido explícito de subir el nivel a
 * Deel/Rippling/ZipRecruiter/Indeed/Workday): zoom lento único sobre la
 * foto (animate-ken-burns), punto "en vivo" en el badge superior, y un
 * indicador de scroll sutil al pie — detalles de pulido que separan un
 * hero "bonito" de uno que se percibe como producto de una empresa
 * tecnológica grande. La transición al pie ahora funde hacia
 * `--surface` (el fondo real de <BenefitsStrip/>, la sección siguiente
 * en Home.tsx) para que el corte sea un degradado, nunca una línea dura.
 */
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-ink text-ink-foreground">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <Photo
          src={PHOTOS.heroOfficeCollaboration.src}
          alt={PHOTOS.heroOfficeCollaboration.alt}
          priority
          className="animate-ken-burns h-full w-full"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-ink via-ink/90 to-ink/50 sm:to-ink/35" aria-hidden />
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-transparent to-ink/30" aria-hidden />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-surface" aria-hidden />
      </div>

      <Container className="relative flex min-h-[92vh] flex-col justify-center py-28 sm:min-h-[85vh]">
        <div className="max-w-2xl">
          <p className="animate-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-ink-foreground/80 backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-emerald-400" aria-hidden />
            </span>
            AI-powered discovery · human-approved every step
          </p>
          <h1
            className="animate-fade-up text-balance text-5xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl"
            style={{ animationDelay: "80ms" }}
          >
            Specialized staffing, <span className="text-gradient">built for how work actually gets done.</span>
          </h1>
          <p
            className="animate-fade-up mt-6 max-w-xl text-balance text-lg text-ink-foreground/80 sm:text-xl"
            style={{ animationDelay: "160ms" }}
          >
            DreiStaff connects employers and skilled talent across Data Centers, Manufacturing, Construction, and
            Warehouse operations — powered by AI-driven discovery and verification, decided by real people.
          </p>
          <div className="animate-fade-up mt-10 flex flex-col gap-4 sm:flex-row" style={{ animationDelay: "240ms" }}>
            <ButtonLink to="/request-talent" size="lg" variant="primary">
              Request Talent <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink
              to="/careers"
              size="lg"
              variant="outline"
              className="border-white/25 bg-white/5 text-ink-foreground backdrop-blur-sm hover:bg-white/15"
            >
              Apply Now
            </ButtonLink>
          </div>
          <div className="animate-fade-up" style={{ animationDelay: "300ms" }}>
            <TrustStrip />
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 sm:block" aria-hidden>
          <ChevronDown className="animate-bounce-slow h-6 w-6 text-ink-foreground/40" />
        </div>
      </Container>
    </section>
  );
}
