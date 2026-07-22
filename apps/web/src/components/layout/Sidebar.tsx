import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  TrendingUp,
  BarChart3,
  Building2,
  Contact,
  UserSearch,
  Kanban,
  Handshake,
  ListChecks,
  Briefcase,
  Users,
  HardHat,
  CalendarClock,
  ShieldCheck,
  Wallet,
  Receipt,
  LineChart,
  Bot,
  CheckSquare,
  Sparkles,
  Settings,
  Megaphone,
  Rocket,
  Radar,
  ShieldAlert,
  FileText,
  Repeat2,
  History,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COLLAPSED_STORAGE_KEY = "dreistaff_sidebar_collapsed";

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
      { to: "/analytics", label: "Analytics", icon: BarChart3, end: true },
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
      { to: "/client-job-requests", label: "Client Requests", icon: FileText },
      { to: "/candidates", label: "Candidates", icon: Users },
      { to: "/workers", label: "Workers", icon: HardHat },
      { to: "/assignments", label: "Assignments", icon: CalendarClock },
      { to: "/schedule-change-requests", label: "Schedule Changes", icon: Repeat2 },
      { to: "/compliance", label: "Compliance", icon: ShieldCheck },
      { to: "/payroll", label: "Payroll", icon: Wallet },
      { to: "/invoices", label: "Invoices", icon: Receipt },
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
      { to: "/audit-log", label: "Audit Trail", icon: History },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

interface SidebarProps {
  // Marca comercial real (GET /branding, ver apps/web/src/lib/branding.ts)
  // — undefined mientras carga. Nunca se hardcodea un nombre acá, y
  // nunca se muestra un placeholder ("…" o similar) mientras carga: el
  // texto simplemente no se renderiza hasta tener el valor real (pedido
  // explícito: "no mostrar ningún placeholder ni puntos suspensivos").
  brandName?: string;
}

export function Sidebar({ brandName }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r border-border bg-card/40 transition-[width] duration-200 md:flex md:flex-col",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex h-14 items-center gap-2 border-b border-border", collapsed ? "justify-center px-2" : "px-4")}>
        <img src="/logo-icon.png" alt="" title={collapsed ? (brandName ?? "DreiStaff") : undefined} className="h-7 w-auto shrink-0" />
        {!collapsed && brandName && <span className="truncate text-sm font-semibold">{brandName}</span>}
      </div>
      <nav
        className={cn("flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-2", collapsed && "px-2")}
        aria-label="Main navigation"
      >
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.title ?? i} className="space-y-0.5">
            {section.title && !collapsed && (
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {section.title}
              </div>
            )}
            {section.items.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={collapsed ? label : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    collapsed && "justify-center px-0",
                    isActive && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
                  )
                }
              >
                {({ isActive }) => (
                  <span className="flex items-center gap-2.5" aria-current={isActive ? "page" : undefined}>
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!collapsed && label}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <button
        type="button"
        onClick={toggleCollapsed}
        className="flex h-11 items-center justify-center gap-2 border-t border-border text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
        {!collapsed && "Collapse"}
      </button>
    </aside>
  );
}
