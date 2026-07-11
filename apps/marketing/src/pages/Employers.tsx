import { CheckCircle2 } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { Section, Eyebrow } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";
import { CTABand } from "@/components/sections/CTABand";
import { StepsList } from "@/components/sections/StepsList";
import { SERVICE_TYPES, HOW_IT_WORKS_EMPLOYERS, INDUSTRIES } from "@/lib/content";

export default function Employers() {
  useSeo({
    title: "For Employers",
    description:
      "Temporary Staffing, Direct Hire, Skilled Trades, and Project Staffing for Data Centers, Manufacturing, Construction, Warehouse, and Industrial operations.",
    path: "/employers",
  });

  return (
    <>
      <Section tone="ink" className="pt-28">
        <div className="max-w-2xl">
          <Eyebrow>For Employers</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Staffing solutions built for how your operation actually runs
          </h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            Whether you need a single skilled tradesperson or a full project crew, we combine AI-assisted discovery
            with human-reviewed vetting to get you qualified talent fast.
          </p>
          <div className="mt-8">
            <ButtonLink to="/request-talent" size="lg" variant="primary">
              Request Talent
            </ButtonLink>
          </div>
        </div>
      </Section>

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Service Types</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">How we can help</h2>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICE_TYPES.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.name} className="rounded-xl border border-border bg-card p-6">
                <Icon className="h-6 w-6 text-primary" />
                <h3 className="mt-4 font-semibold">{s.name}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Industries We Serve</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Specialized coverage, not generalist guesswork
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {INDUSTRIES.map((ind) => {
            const Icon = ind.icon;
            return (
              <div key={ind.slug} className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
                <Icon className="h-5 w-5 shrink-0 text-primary" />
                <span className="text-sm font-medium">{ind.name}</span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Process</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">From request to placement</h2>
        </div>
        <StepsList steps={HOW_IT_WORKS_EMPLOYERS} />
      </Section>

      <Section tone="muted">
        <div className="grid grid-cols-1 gap-16 lg:grid-cols-2 lg:items-center">
          <div>
            <Eyebrow>Why DreiStaff</Eyebrow>
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              Built for accuracy, not volume
            </h2>
            <p className="mt-4 text-muted-foreground">
              We'd rather send you three well-vetted candidates than thirty unqualified ones.
            </p>
          </div>
          <ul className="space-y-4">
            {[
              "Every candidate reviewed by a recruiter before you see them",
              "AI-assisted discovery grounded in verified, real data — never fabricated leads",
              "Flexible engagement models that scale with your project",
              "A dedicated account team for the life of the relationship",
              "Compliance-aware sourcing across every state we serve",
            ].map((item) => (
              <li key={item} className="flex gap-3 text-sm">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <CTABand
        title="Tell us what you need"
        description="Submit a Request Talent form and a member of our team will follow up within one business day."
        primary={{ to: "/request-talent", label: "Request Talent" }}
      />
    </>
  );
}
