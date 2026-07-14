import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  TrendingUp,
  Building2,
  Contact,
  UserSearch,
  Kanban,
  Handshake,
  ListChecks,
  Briefcase,
  Users,
  HardHat,
  ShieldCheck,
  Wallet,
  LineChart,
  Bot,
  CheckSquare,
  Sparkles,
  Settings,
  Megaphone,
  Rocket,
  Radar,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/revenue", label: "Revenue", icon: TrendingUp },
    ],
  },
  {
    title: "Sales CRM",
    items: [
      { to: "/companies", label: "Companies", icon: Building2 },
      { to: "/contacts", label: "Contacts", icon: Contact },
      { to: "/leads", label: "Leads", icon: UserSearch },
      { to: "/pipeline", label: "Pipeline", icon: Kanban },
      { to: "/opportunities", label: "Opportunities", icon: Handshake },
      { to: "/follow-ups", label: "Follow-ups", icon: ListChecks },
      { to: "/campaigns", label: "Campaigns", icon: Megaphone },
    ],
  },
  {
    title: "Operations",
    items: [
      { to: "/job-orders", label: "Job Orders", icon: Briefcase },
      { to: "/candidates", label: "Candidates", icon: Users },
      { to: "/workers", label: "Workers", icon: HardHat },
      { to: "/compliance", label: "Compliance", icon: ShieldCheck },
      { to: "/payroll", label: "Payroll", icon: Wallet },
      { to: "/pricing", label: "Pricing", icon: LineChart },
    ],
  },
  {
    items: [
      { to: "/missions", label: "Daily Mission", icon: Rocket },
      { to: "/discovery", label: "External Discovery", icon: Radar },
      { to: "/agents", label: "AI Agents", icon: Bot },
      { to: "/approvals", label: "Approvals", icon: CheckSquare },
      { to: "/ai-dashboard", label: "AI Dashboard", icon: Sparkles },
      { to: "/production-readiness", label: "Production Readiness", icon: ShieldAlert },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

interface SidebarProps {
  // Marca comercial real (GET /branding, ver apps/web/src/lib/branding.ts)
  // — undefined mientras carga. Nunca se hardcodea un nombre acá; el
  // placeholder "…" es deliberado (evita mostrar una marca vieja/incorrecta
  // por un instante mientras se resuelve la real).
  brandName?: string;
}

export function Sidebar({ brandName }: SidebarProps) {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-card/40 md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          {brandName?.[0] ?? "…"}
        </div>
        <span className="text-sm font-semibold">{brandName ?? "…"}</span>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.title ?? i} className="space-y-0.5">
            {section.title && (
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {section.title}
              </div>
            )}
            {section.items.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    isActive && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
