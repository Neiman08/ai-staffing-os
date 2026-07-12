import { useSeo } from "@/lib/seo";
import { Hero } from "@/components/sections/Hero";
import { BenefitsStrip } from "@/components/sections/BenefitsStrip";
import { StatsBar } from "@/components/sections/StatsBar";
import { IndustriesGrid } from "@/components/sections/IndustriesGrid";
import { StepsList } from "@/components/sections/StepsList";
import { AICapabilities } from "@/components/sections/AICapabilities";
import { FAQAccordion } from "@/components/sections/FAQAccordion";
import { CTABand } from "@/components/sections/CTABand";
import { SplitPanel } from "@/components/sections/SplitPanel";
import { Section, Eyebrow } from "@/components/ui/Section";
import { PhotoCard } from "@/components/ui/PhotoCard";
import { PHOTOS } from "@/lib/photos";
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
      <BenefitsStrip />

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Our Solutions</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Staffing solutions tailored to <span className="text-primary">you</span>
          </h2>
          <p className="mt-4 text-muted-foreground">
            No two companies are the same — our engagement models are built around your industry and timeline.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICE_TYPES.map((s) => (
            <PhotoCard key={s.name} photo={s.photo} icon={s.icon} title={s.name} description={s.description} />
          ))}
        </div>
      </Section>

      <StatsBar />

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">From request to placement</h2>
        </div>
        <StepsList steps={HOW_IT_WORKS_EMPLOYERS} />
      </Section>

      <section className="grid grid-cols-1 lg:grid-cols-2">
        <SplitPanel
          photo={PHOTOS.professionalPortraitWoman}
          eyebrow="For Candidates"
          title="Real openings,"
          titleAccent="matched to your trade"
          description="Apply once — we match you against active, verified openings. A real recruiter reviews every application, never a black box."
          cta={{ to: "/careers", label: "Browse Jobs" }}
        />
        <SplitPanel
          photo={PHOTOS.professionalPortraitMan}
          eyebrow="For Employers"
          title="Fill roles faster,"
          titleAccent="without lowering the bar"
          description="Every candidate reviewed by a recruiter before you see them. Flexible engagement models, a dedicated account team."
          cta={{ to: "/request-talent", label: "Request Talent" }}
        />
      </section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Industries</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Built for specialized trades</h2>
          <p className="mt-4 text-muted-foreground">
            We focus where staffing is hardest to get right — mission-critical builds and skilled industrial trades.
          </p>
        </div>
        <IndustriesGrid />
      </Section>

      <Section>
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
