import { ShieldCheck, Lock, UserCheck } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { Section, Eyebrow } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";
import { CTABand } from "@/components/sections/CTABand";
import { StepsList } from "@/components/sections/StepsList";
import { PHOTOS } from "@/lib/photos";
import { HOW_IT_WORKS_CANDIDATES } from "@/lib/content";

const SECURITY_POINTS = [
  {
    icon: Lock,
    title: "Your data stays protected",
    description: "We never sell your information. Your details are used only to match you with real, active openings.",
  },
  {
    icon: UserCheck,
    title: "A real person reviews you",
    description: "No automated rejections — every application is reviewed by a recruiter before any decision is made.",
  },
  {
    icon: ShieldCheck,
    title: "Transparent every step",
    description: "You'll know where you stand throughout the process, from application to first day on the job.",
  },
];

export default function Candidates() {
  useSeo({
    title: "For Candidates",
    description:
      "Find real, verified job openings in Data Centers, Manufacturing, Construction, and Warehouse trades. Apply in minutes and work with a real recruiter.",
    path: "/candidates",
  });

  return (
    <>
      <Section tone="ink" className="pt-28" backgroundPhoto={PHOTOS.professionalPortraitWoman}>
        <div className="max-w-2xl">
          <Eyebrow>For Candidates</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Find your next role, with a recruiter who actually reads your application
          </h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            We match you against real, active openings in your trade — no mass-blasted job boards, no black-box
            algorithms deciding your future.
          </p>
          <div className="mt-8">
            <ButtonLink to="/careers" size="lg" variant="primary">
              Apply Now
            </ButtonLink>
          </div>
        </div>
      </Section>

      <Section>
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Process</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2>
        </div>
        <StepsList steps={HOW_IT_WORKS_CANDIDATES} />
      </Section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Security &amp; Trust</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Your information, handled responsibly
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {SECURITY_POINTS.map((p) => (
            <div key={p.title} className="rounded-xl border border-border bg-card p-6">
              <p.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{p.description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>Benefits</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Why apply through us</h2>
          <p className="mt-4 text-muted-foreground">
            We work directly with employers across Data Centers, Manufacturing, Construction, Warehouse, and
            Industrial operations — meaning faster answers and roles that actually match your experience, whether
            you're looking for temporary work, a direct hire opportunity, or your next skilled trade assignment.
          </p>
        </div>
      </Section>

      <CTABand
        title="Ready for your next role?"
        description="Applying takes just a few minutes — no account required."
        primary={{ to: "/careers", label: "Apply Now" }}
      />
    </>
  );
}
