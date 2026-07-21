import { Link } from "react-router-dom";
import { usePublicBranding } from "@/lib/branding";
import { Container } from "@/components/ui/Container";

const COLUMNS: Array<{ title: string; links: Array<{ to: string; label: string }> }> = [
  {
    title: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/industries", label: "Industries" },
      { to: "/contact", label: "Contact" },
    ],
  },
  {
    title: "For Employers",
    links: [
      { to: "/employers", label: "Employer Solutions" },
      { to: "/request-talent", label: "Request Talent" },
    ],
  },
  {
    title: "For Candidates",
    links: [
      { to: "/candidates", label: "Find Work" },
      { to: "/careers", label: "Careers" },
    ],
  },
  {
    title: "Legal",
    links: [
      { to: "/privacy", label: "Privacy Policy" },
      { to: "/terms", label: "Terms of Service" },
    ],
  },
];

export function Footer() {
  const branding = usePublicBranding();
  const brandName = branding?.brandName ?? "";
  const legalName = branding?.legalName ?? "";
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 bg-surface text-ink-foreground">
      <Container className="py-16">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-6">
          <div className="col-span-2 sm:col-span-2">
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <img src="/logo-icon.png" alt="" className="h-8 w-auto" />
              <span className="text-lg tracking-tight">{brandName || "…"}</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm text-ink-foreground/60">
              Specialized staffing for the industries that keep everything running.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-widest text-ink-foreground/50">{col.title}</p>
              <ul className="mt-4 space-y-3">
                {col.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className="text-sm text-ink-foreground/80 transition-colors hover:text-ink-foreground">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-2 border-t border-white/10 pt-8 text-xs text-ink-foreground/50 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {legalName || "…"}. {brandName ? `${brandName} is a brand of ${legalName}.` : ""}
          </p>
          <p>Illinois · Indiana · Iowa · Nebraska · Wisconsin · Michigan · Ohio · Missouri</p>
        </div>
      </Container>
    </footer>
  );
}
