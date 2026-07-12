import { ArrowRight, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";

export function CTABand({
  title,
  description,
  primary,
  secondary,
}: {
  title: string;
  description: string;
  primary: { to: string; label: string };
  secondary?: { to: string; label: string };
}) {
  return (
    <section className="bg-primary text-primary-foreground">
      <Container className="flex flex-col items-center justify-between gap-8 py-16 text-center lg:flex-row lg:text-left">
        <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-center">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/15">
            <Sparkles className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
            <p className="mt-1 max-w-md text-balance text-primary-foreground/80">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <ButtonLink to={primary.to} size="lg" variant="inverse">
            {primary.label} <ArrowRight className="h-4 w-4" />
          </ButtonLink>
          {secondary && (
            <ButtonLink to={secondary.to} size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10">
              {secondary.label}
            </ButtonLink>
          )}
        </div>
      </Container>
    </section>
  );
}
