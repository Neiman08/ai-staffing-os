import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { Photo } from "@/components/ui/Photo";
import { TrustStrip } from "./TrustStrip";
import { PHOTOS } from "@/lib/photos";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-ink to-surface text-ink-foreground">
      <div className="absolute inset-0 bg-grid-fade" aria-hidden />
      <div className="absolute -top-40 left-1/4 h-96 w-[50rem] -translate-x-1/2 rounded-full bg-primary/25 blur-[120px]" aria-hidden />

      <Container className="relative py-20 sm:py-28">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="animate-fade-up mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-ink-foreground/80">
              AI-powered discovery · human-approved every step
            </p>
            <h1
              className="animate-fade-up text-balance text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl"
              style={{ animationDelay: "80ms" }}
            >
              Specialized staffing, <span className="text-gradient">built for how work actually gets done.</span>
            </h1>
            <p
              className="animate-fade-up mt-6 max-w-xl text-balance text-lg text-ink-foreground/70"
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
                className="border-white/20 text-ink-foreground hover:bg-white/10"
              >
                Apply Now
              </ButtonLink>
            </div>
            <div className="animate-fade-up" style={{ animationDelay: "300ms" }}>
              <TrustStrip />
            </div>
          </div>

          <div className="animate-fade-up relative" style={{ animationDelay: "180ms" }}>
            <div className="absolute inset-0 -z-10 translate-x-4 translate-y-4 rounded-2xl bg-primary/20 blur-2xl" aria-hidden />
            <Photo
              src={PHOTOS.heroOfficeCollaboration.src}
              alt={PHOTOS.heroOfficeCollaboration.alt}
              priority
              className="aspect-[4/5] rounded-2xl shadow-2xl ring-1 ring-white/10 sm:aspect-[5/4]"
            />
          </div>
        </div>
      </Container>
    </section>
  );
}
