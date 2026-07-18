import { NavLink } from "react-router-dom";
import { LayoutDashboard, Briefcase, FileText, Users2, CalendarClock, Clock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

// F10.2: Client Portal -- sin las secciones internas (CRM, Pricing,
// Agentes, Settings). Placements/Assignments/Workers son vistas
// distintas del mismo dominio (roster vs. historial), mismo criterio
// que la separación Assignments/Workers ya existente en el shell
// interno.
const CLIENT_NAV: NavItem[] = [
  { to: "/portal/client", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/portal/client/job-requests", label: "Job Requests", icon: FileText },
  { to: "/portal/client/job-orders", label: "Job Orders", icon: Briefcase },
  { to: "/portal/client/workers", label: "Workers", icon: Users2 },
  { to: "/portal/client/assignments", label: "Assignments", icon: CalendarClock },
  { to: "/portal/client/time-entries", label: "Time Entries", icon: Clock },
  { to: "/portal/client/incidents", label: "Incidents", icon: ShieldAlert },
];

export function PortalSidebar({ brandName }: { brandName?: string }) {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-card/40 md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          {brandName?.[0] ?? "…"}
        </div>
        <span className="text-sm font-semibold">{brandName ?? "…"} Portal</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {CLIENT_NAV.map(({ to, label, icon: Icon, end }) => (
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
      </nav>
    </aside>
  );
}
