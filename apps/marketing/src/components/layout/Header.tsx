import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { usePublicBranding } from "@/lib/branding";
import { APP_URL } from "@/lib/app-url";
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

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-ink/85 text-ink-foreground backdrop-blur-md transition-colors">
      <Container className="flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 font-semibold">
          <img src="/logo-icon.png" alt="" className="h-10 w-auto sm:h-11" />
          <span className="text-lg tracking-tight">{branding?.brandName ?? "…"}</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cn(
                  "text-sm font-medium text-ink-foreground/70 transition-colors hover:text-ink-foreground",
                  isActive && "text-ink-foreground",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <ButtonLink
            to="/request-talent"
            size="md"
            variant="outline"
            className="border-white/20 text-ink-foreground hover:bg-white/10"
          >
            Request Talent
          </ButtonLink>
          <ButtonLink to={APP_URL ?? "#"} external={!!APP_URL} size="md" variant="primary" aria-disabled={!APP_URL}>
            Login
          </ButtonLink>
        </div>

        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-ink-foreground md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </Container>

      {open && (
        <div className="border-t border-white/10 bg-ink md:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2 text-sm font-medium text-ink-foreground/80 hover:bg-white/10"
              >
                {l.label}
              </NavLink>
            ))}
            <div className="mt-2 flex flex-col gap-2">
              <ButtonLink
                to="/request-talent"
                variant="outline"
                className="border-white/20 text-ink-foreground hover:bg-white/10"
                onClick={() => setOpen(false)}
              >
                Request Talent
              </ButtonLink>
              <ButtonLink to={APP_URL ?? "#"} external={!!APP_URL} variant="primary" aria-disabled={!APP_URL}>
                Login
              </ButtonLink>
            </div>
          </Container>
        </div>
      )}
    </header>
  );
}
