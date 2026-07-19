import { useEffect } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { APP_URL } from "@/lib/app-url";
import { Section } from "@/components/ui/Section";
import { ButtonLink } from "@/components/ui/Button";

// F4.8/F14: esta página NO implementa autenticación — solo dirige al
// portal privado real (VITE_APP_URL, ver lib/app-url.ts), que ahora sí
// tiene login real (ver apps/web).
export default function Login() {
  useSeo({
    title: "Login",
    description: "Access your DreiStaff account.",
    path: "/login",
  });

  useEffect(() => {
    if (APP_URL) {
      window.location.href = APP_URL;
    }
  }, []);

  return (
    <Section className="pt-28">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
        {APP_URL ? (
          <>
            <h1 className="text-2xl font-bold tracking-tight">Redirecting to your account…</h1>
            <p className="text-sm text-muted-foreground">
              If you aren't redirected automatically, use the button below.
            </p>
            <ButtonLink to={APP_URL} external size="lg">
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
