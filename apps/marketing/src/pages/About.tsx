import { Target, Compass, Cpu, Handshake } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { usePublicBranding } from "@/lib/branding";
import { Section, Eyebrow } from "@/components/ui/Section";
import { CTABand } from "@/components/sections/CTABand";
import { PHOTOS } from "@/lib/photos";

const VALUES = [
  {
    icon: Target,
    title: "Accuracy over volume",
    description: "We'd rather send three well-vetted candidates than thirty unqualified ones.",
  },
  {
    icon: Compass,
    title: "Never fabricate",
    description: "Every contact, credential, and data point we act on is verified — never guessed, never invented.",
  },
  {
    icon: Handshake,
    title: "Human decisions, always",
    description: "Technology accelerates our research. People make every decision that affects a candidate or a client.",
  },
  {
    icon: Cpu,
    title: "Built on real technology",
    description: "Our AI-assisted discovery and verification pipeline is purpose-built for specialized staffing, not bolted on.",
  },
];

export default function About() {
  const branding = usePublicBranding();
  const brandName = branding?.brandName ?? "our team";
  const legalName = branding?.legalName;

  useSeo({
    title: "About Us",
    description: `Learn about ${brandName}'s mission, values, and AI-assisted approach to specialized staffing.`,
    path: "/about",
  });

  return (
    <>
      <Section tone="ink" className="pt-28" backgroundPhoto={PHOTOS.teamMeetingDiscussion}>
        <div className="max-w-2xl">
          <Eyebrow>About Us</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Specialized staffing, rebuilt around real technology
          </h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            {brandName} exists to solve a simple problem: specialized trades staffing has been slow, opaque, and
            hit-or-miss for too long. We combine experienced recruiters with an AI-assisted discovery and
            verification pipeline to change that — without ever letting technology make the decisions that should
            stay human.
          </p>
        </div>
      </Section>

      <Section>
        <div className="grid grid-cols-1 gap-16 lg:grid-cols-2">
          <div>
            <Eyebrow>Mission</Eyebrow>
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Connect skilled talent with the employers who need them, faster and more accurately
            </h2>
            <p className="mt-4 text-muted-foreground">
              Whether it's a data center commissioning crew or a single journeyman electrician, we treat every
              request with the same rigor: verified sourcing, human review, and follow-through from first contact to
              placement.
            </p>
          </div>
          <div>
            <Eyebrow>Approach</Eyebrow>
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              AI accelerates the search. People make the call.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Our platform helps our recruiters find and verify real opportunities and real candidates faster than
              manual sourcing alone — but every outreach, every match, and every placement decision is reviewed and
              approved by a person before it happens.
            </p>
          </div>
        </div>
      </Section>

      <Section tone="muted">
        <div className="mx-auto mb-14 max-w-2xl text-center">
          <Eyebrow>Values</Eyebrow>
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">What guides our work</h2>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {VALUES.map((v) => (
            <div key={v.title} className="rounded-xl border border-border bg-card p-6">
              <v.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-semibold">{v.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{v.description}</p>
            </div>
          ))}
        </div>
      </Section>

      {legalName && (
        <Section>
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>Corporate Information</Eyebrow>
            <p className="text-sm text-muted-foreground">
              {brandName} is a brand operated by {legalName}. All staffing services are provided under {legalName}.
            </p>
          </div>
        </Section>
      )}

      <CTABand
        title="Want to learn more?"
        description="Reach out to our team — we're happy to talk through how we can help."
        primary={{ to: "/contact", label: "Contact Us" }}
      />
    </>
  );
}
