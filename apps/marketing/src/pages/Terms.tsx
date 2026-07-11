import { useSeo } from "@/lib/seo";
import { usePublicBranding } from "@/lib/branding";
import { Section, Eyebrow } from "@/components/ui/Section";

export default function Terms() {
  const branding = usePublicBranding();
  const brandName = branding?.brandName ?? "our company";
  const legalName = branding?.legalName ?? brandName;

  useSeo({
    title: "Terms of Service",
    description: `The terms governing use of ${brandName}'s website.`,
    path: "/terms",
  });

  return (
    <Section className="pt-28">
      <div className="mx-auto max-w-3xl">
        <Eyebrow>Legal</Eyebrow>
        <h1 className="text-balance text-4xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-4 text-sm text-muted-foreground">Last updated: {new Date().getFullYear()}</p>

        <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground">
          <p>
            These Terms of Service govern your use of this website, operated by {legalName} under the {brandName}{" "}
            brand. By using this site, you agree to these terms.
          </p>

          <section>
            <h2 className="text-base font-semibold text-foreground">Use of This Site</h2>
            <p className="mt-2">
              This website is provided for informational purposes and to allow employers and candidates to submit
              inquiries and applications. You agree to provide accurate information when submitting any form on this
              site.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">No Guarantee of Placement</h2>
            <p className="mt-2">
              Submitting a Request Talent form or a job application does not guarantee a placement, interview, or
              response. All staffing and hiring decisions are made at the sole discretion of {legalName} and the
              relevant employer.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Intellectual Property</h2>
            <p className="mt-2">
              All content on this site, including text, graphics, and branding, is the property of {legalName} and
              may not be reproduced without permission.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Limitation of Liability</h2>
            <p className="mt-2">
              This site is provided "as is" without warranties of any kind. {legalName} is not liable for any
              damages arising from your use of this site.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Changes to These Terms</h2>
            <p className="mt-2">
              We may update these terms from time to time. Continued use of this site constitutes acceptance of any
              changes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-foreground">Contact</h2>
            <p className="mt-2">
              Questions about these terms can be directed to us through our{" "}
              <a href="/contact" className="text-primary underline underline-offset-2">
                Contact page
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </Section>
  );
}
