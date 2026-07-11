import { ArrowRight } from "lucide-react";
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
    <section className="bg-ink text-ink-foreground">
      <Container className="flex flex-col items-center gap-6 py-20 text-center">
        <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
        <p className="max-w-xl text-balance text-ink-foreground/70">{description}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <ButtonLink to={primary.to} size="lg" variant="primary">
            {primary.label} <ArrowRight className="h-4 w-4" />
          </ButtonLink>
          {secondary && (
            <ButtonLink to={secondary.to} size="lg" variant="outline" className="border-white/20 text-ink-foreground hover:bg-white/10">
              {secondary.label}
            </ButtonLink>
          )}
        </div>
      </Container>
    </section>
  );
}
