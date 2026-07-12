import { useSeo } from "@/lib/seo";
import { Section, Eyebrow } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";
import { CTABand } from "@/components/sections/CTABand";
import { PHOTOS } from "@/lib/photos";
import { INDUSTRIES } from "@/lib/content";

export default function Industries() {
  useSeo({
    title: "Industries We Serve",
    description:
      "Specialized staffing for Data Centers, Electrical, Mechanical, Construction, Manufacturing, Warehouse, and Industrial operations.",
    path: "/industries",
  });

  return (
    <>
      <Section tone="ink" className="pt-28" backgroundPhoto={PHOTOS.weldingSkilledTrade}>
        <div className="max-w-2xl">
          <Eyebrow>Industries</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Deep coverage where staffing is hardest to get right
          </h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            We don't try to be everything to everyone. Our recruiters and our technology are focused on the trades
            below.
          </p>
        </div>
      </Section>

      <Section>
        <div className="space-y-16">
          {INDUSTRIES.map((ind) => {
            const Icon = ind.icon;
            return (
              <div
                key={ind.slug}
                id={ind.slug}
                className="grid grid-cols-1 items-center gap-10 border-b border-border pb-16 last:border-0 last:pb-0 lg:grid-cols-3"
              >
                <div className="lg:col-span-1">
                  <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-7 w-7" />
                  </span>
                  <h2 className="mt-4 text-2xl font-bold tracking-tight">{ind.name}</h2>
                  <p className="mt-2 text-sm font-medium text-muted-foreground">{ind.summary}</p>
                </div>
                <div className="lg:col-span-2">
                  <p className="text-muted-foreground">{ind.detail}</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <ButtonLink to="/request-talent" variant="outline">
                      Request Talent
                    </ButtonLink>
                    <ButtonLink to="/careers" variant="ghost">
                      Find Work in {ind.name}
                    </ButtonLink>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <CTABand
        title="Don't see your exact trade?"
        description="Reach out — our recruiting team covers a wide range of skilled and industrial roles beyond this list."
        primary={{ to: "/contact", label: "Contact Us" }}
      />
    </>
  );
}
