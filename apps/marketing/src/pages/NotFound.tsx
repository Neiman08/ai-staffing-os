import { useSeo } from "@/lib/seo";
import { Section } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";

export default function NotFound() {
  useSeo({
    title: "Page Not Found",
    description: "The page you're looking for doesn't exist.",
    path: "/404",
  });

  return (
    <Section className="pt-28">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">404</p>
        <h1 className="text-3xl font-bold tracking-tight">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page you're looking for doesn't exist or may have moved.
        </p>
        <ButtonLink to="/" size="lg">
          Back to Home
        </ButtonLink>
      </div>
    </Section>
  );
}
