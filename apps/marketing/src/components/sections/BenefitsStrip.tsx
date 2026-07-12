import { BENEFITS } from "@/lib/content";
import { Container } from "@/components/ui/Container";

export function BenefitsStrip() {
  return (
    <div className="bg-surface text-ink-foreground">
      <Container className="grid grid-cols-1 divide-y divide-white/10 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
        {BENEFITS.map((b) => (
          <div key={b.title} className="group px-6 py-10 transition-colors first:pl-0 last:pr-0 hover:bg-white/[0.03] sm:px-8">
            <b.icon className="h-6 w-6 text-primary transition-transform group-hover:-translate-y-0.5" />
            <h3 className="mt-4 font-semibold">{b.title}</h3>
            <p className="mt-2 text-sm text-ink-foreground/60">{b.description}</p>
          </div>
        ))}
      </Container>
    </div>
  );
}
