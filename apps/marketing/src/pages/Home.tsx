import { useSeo } from "@/lib/seo";
import { Hero } from "@/components/sections/Hero";
import { StatsBar } from "@/components/sections/StatsBar";
import { IndustriesGrid } from "@/components/sections/IndustriesGrid";
import { StepsList } from "@/components/sections/StepsList";
import { AICapabilities } from "@/components/sections/AICapabilities";
import { FAQAccordion } from "@/components/sections/FAQAccordion";
import { CTABand } from "@/components/sections/CTABand";
import { Section, Eyebrow } from "@/components/ui/Section";
import { HOW_IT_WORKS_EMPLOYERS, SERVICE_TYPES } from "@/lib/content";

export default function Home() {
  useSeo({
    title: "Specialized Staffing, Powered by AI",
    description:
      "DreiStaff connects employers and skilled talent across Data Centers, Manufacturing, Construction, and Warehouse operations — powered by AI-driven discovery and verification.",
    path: "/",
  });

  return (
    <>
      <Hero />
      <StatsBar />

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Industries</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Built for specialized trades</h2>
          <p className="mt-4 text-muted-foreground">
            We focus where staffing is hardest to get right — mission-critical builds and skilled industrial trades.
          </p>
        </div>
        <IndustriesGrid />
      </Section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">From request to placement</h2>
        </div>
        <StepsList steps={HOW_IT_WORKS_EMPLOYERS} />
      </Section>

      <Section>
        <div className="grid grid-cols-1 gap-16 lg:grid-cols-2">
          <div>
            <Eyebrow>For Employers</Eyebrow>
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Fill roles faster, without lowering the bar
            </h2>
            <ul className="mt-6 space-y-4">
              {[
                "Access to a continuously growing, AI-verified employer and talent network",
                "Every candidate reviewed by a recruiter before you see them",
                "Flexible engagement models — temporary, direct hire, or project-based",
                "A dedicated account team, not a ticket queue",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Eyebrow>For Candidates</Eyebrow>
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Real openings, matched to your trade
            </h2>
            <ul className="mt-6 space-y-4">
              {[
                "Apply once — we match you against active, verified openings",
                "A real recruiter reviews your application, never a black box",
                "Transparent process from application to first day",
                "We never sell or share your data beyond the placement process",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Technology</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">AI-powered, human-decided</h2>
          <p className="mt-4 text-muted-foreground">
            Our platform accelerates research and verification — every decision that matters still goes through a
            person.
          </p>
        </div>
        <AICapabilities />
      </Section>

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Service Types</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Engagement models that fit</h2>
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
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Common questions</h2>
        </div>
        <FAQAccordion />
      </Section>

      <CTABand
        title="Ready to get started?"
        description="Whether you're hiring or looking for your next role, we're ready to help."
        primary={{ to: "/request-talent", label: "Request Talent" }}
        secondary={{ to: "/careers", label: "Apply Now" }}
      />
    </>
  );
}
