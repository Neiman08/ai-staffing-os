import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-ink text-ink-foreground">
      <div className="absolute inset-0 bg-grid-fade" aria-hidden />
      <div className="absolute -top-40 left-1/2 h-96 w-[60rem] -translate-x-1/2 rounded-full bg-primary/30 blur-[120px]" aria-hidden />

      <Container className="relative py-28 sm:py-36">
        <div className="mx-auto max-w-3xl text-center">
          <p className="animate-fade-up mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-ink-foreground/80">
            AI-powered discovery · human-approved every step
          </p>
          <h1 className="animate-fade-up text-balance text-4xl font-extrabold tracking-tight sm:text-6xl" style={{ animationDelay: "80ms" }}>
            Specialized staffing, <span className="text-gradient">built for how work actually gets done.</span>
          </h1>
          <p className="animate-fade-up mx-auto mt-6 max-w-2xl text-balance text-lg text-ink-foreground/70" style={{ animationDelay: "160ms" }}>
            DreiStaff connects employers and skilled talent across Data Centers, Manufacturing, Construction, and
            Warehouse operations — powered by AI-driven discovery and verification, decided by real people.
          </p>
          <div className="animate-fade-up mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row" style={{ animationDelay: "240ms" }}>
            <ButtonLink to="/request-talent" size="lg" variant="primary">
              Request Talent <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink to="/careers" size="lg" variant="outline" className="border-white/20 text-ink-foreground hover:bg-white/10">
              Apply Now
            </ButtonLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
