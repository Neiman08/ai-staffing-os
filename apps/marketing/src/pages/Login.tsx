import { useEffect } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { usePublicBranding } from "@/lib/branding";
import { Section } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";

// F4.8: esta página NO implementa autenticación — solo dirige al
// portal privado (app.<domain>). La autenticación real es F4.9.
export default function Login() {
  useSeo({
    title: "Login",
    description: "Access your DreiStaff account.",
    path: "/login",
  });

  const branding = usePublicBranding();
  const appUrl = branding?.appDomain ? `https://${branding.appDomain}` : undefined;

  useEffect(() => {
    if (appUrl) {
      window.location.href = appUrl;
    }
  }, [appUrl]);

  return (
    <Section className="pt-28">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
        {appUrl ? (
          <>
            <h1 className="text-2xl font-bold tracking-tight">Redirecting to your account…</h1>
            <p className="text-sm text-muted-foreground">
              If you aren't redirected automatically, use the button below.
            </p>
            <ButtonLink to={appUrl} external size="lg">
              Go to Login <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Preparing your login…</p>
          </>
        )}
      </div>
    </Section>
  );
}
