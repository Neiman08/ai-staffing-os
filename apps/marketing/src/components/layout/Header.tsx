import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { usePublicBranding } from "@/lib/branding";
import { resolveAppUrl } from "@/lib/app-url";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { to: "/employers", label: "Employers" },
  { to: "/candidates", label: "Candidates" },
  { to: "/industries", label: "Industries" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
];

export function Header() {
  const branding = usePublicBranding();
  const [open, setOpen] = useState(false);
  // F4.8/F4.9: "El botón Login debe dirigir a https://app.dreistaff.com
  // (o http://localhost:5173 en local)" — nunca hardcodeado, viene del
  // mismo branding real que todo lo demás. Ver lib/app-url.ts.
  const appUrl = resolveAppUrl(branding?.appDomain);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            {branding?.brandName?.[0] ?? "…"}
          </span>
          <span className="text-lg tracking-tight">{branding?.brandName ?? "…"}</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cn("text-sm font-medium text-foreground/70 transition-colors hover:text-foreground", isActive && "text-foreground")
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <ButtonLink to="/request-talent" size="md" variant="outline">
            Request Talent
          </ButtonLink>
          <ButtonLink to={appUrl ?? "#"} external={!!appUrl} size="md" variant="primary" aria-disabled={!appUrl}>
            Login
          </ButtonLink>
        </div>

        <button
          className="flex h-9 w-9 items-center justify-center rounded-md md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </Container>

      {open && (
        <div className="border-t border-border bg-background md:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2 text-sm font-medium text-foreground/80 hover:bg-muted"
              >
                {l.label}
              </NavLink>
            ))}
            <div className="mt-2 flex flex-col gap-2">
              <ButtonLink to="/request-talent" variant="outline" onClick={() => setOpen(false)}>
                Request Talent
              </ButtonLink>
              <ButtonLink to={appUrl ?? "#"} external={!!appUrl} variant="primary" aria-disabled={!appUrl}>
                Login
              </ButtonLink>
            </div>
          </Container>
        </div>
      )}
    </header>
  );
}
