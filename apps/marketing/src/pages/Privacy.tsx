import { useSeo } from "@/lib/seo";
import { usePublicBranding } from "@/lib/branding";
import { Section, Eyebrow } from "@/components/ui/Section";

export default function Privacy() {
  const branding = usePublicBranding();
  const brandName = branding?.brandName ?? "our company";
  const legalName = branding?.legalName ?? brandName;
  const contactEmail = branding?.outreachReplyTo ?? branding?.outreachFromEmail;

  useSeo({
    title: "Privacy Policy",
    description: `How ${brandName} collects, uses, and protects your information.`,
    path: "/privacy",
  });

  return (
    <Section className="pt-28">
      <div className="mx-auto max-w-3xl">
        <Eyebrow>Legal</Eyebrow>
        <h1 className="text-balance text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-4 text-sm text-muted-foreground">Last updated: {new Date().getFullYear()}</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground">
          <p>
            {brandName} ("we," "us," or "our") is a brand operated by {legalName}. This Privacy Policy explains how
            we collect, use, and protect information submitted through this website, including through our Contact,
            Request Talent, and Careers forms.
          </p>

          <section>
            <h2 className="text-base font-semibold text-foreground">Information We Collect</h2>
            <p className="mt-2">
              We collect information you voluntarily provide through our forms, including your name, email address,
              phone number, company name, location, and — for candidates — trade experience and resume information.
              We do not collect this information through hidden tracking or third-party data brokers.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">How We Use Information</h2>
            <p className="mt-2">
              Information submitted through this site is used solely to respond to your inquiry, evaluate a staffing
              request, or evaluate a candidate application. We do not sell your personal information to third
              parties.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Data Retention</h2>
            <p className="mt-2">
              We retain information for as long as reasonably necessary to fulfill the purpose it was collected for,
              including ongoing recruiting and staffing relationships, unless a longer retention period is required
              by law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Your Rights</h2>
            <p className="mt-2">
              You may request access to, correction of, or deletion of your personal information at any time by
              contacting us using the details below.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Contact</h2>
            <p className="mt-2">
              Questions about this policy can be directed to us through our{" "}
              <a href="/contact" className="text-primary underline underline-offset-2">
                Contact page
              </a>
              {contactEmail ? ` or by email at ${contactEmail}` : ""}.
            </p>
          </section>
        </div>
      </div>
    </Section>
  );
}
