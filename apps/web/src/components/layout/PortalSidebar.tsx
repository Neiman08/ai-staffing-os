import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Briefcase,
  FileText,
  Users2,
  CalendarClock,
  Clock,
  ShieldAlert,
  User,
  FolderCheck,
  History,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COLLAPSED_STORAGE_KEY = "dreistaff_sidebar_collapsed";

export interface NavItem {
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
export const CLIENT_NAV: NavItem[] = [
  { to: "/portal/client", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/portal/client/job-requests", label: "Job Requests", icon: FileText },
  { to: "/portal/client/job-orders", label: "Job Orders", icon: Briefcase },
  { to: "/portal/client/workers", label: "Workers", icon: Users2 },
  { to: "/portal/client/assignments", label: "Assignments", icon: CalendarClock },
  { to: "/portal/client/time-entries", label: "Time Entries", icon: Clock },
  { to: "/portal/client/incidents", label: "Incidents", icon: ShieldAlert },
  { to: "/portal/client/audit-log", label: "Audit Trail", icon: History },
];

// F10.4: Worker Portal.
export const WORKER_NAV: NavItem[] = [
  { to: "/portal/worker", label: "Profile", icon: User, end: true },
  { to: "/portal/worker/onboarding", label: "Onboarding", icon: FolderCheck },
  { to: "/portal/worker/documents", label: "Documents", icon: FileText },
  { to: "/portal/worker/assignments", label: "Assignments", icon: CalendarClock },
  { to: "/portal/worker/time-entries", label: "Time Entries", icon: Clock },
  { to: "/portal/worker/incidents", label: "Incidents", icon: ShieldAlert },
  { to: "/portal/worker/audit-log", label: "Audit Trail", icon: History },
];

// F10.4: Candidate Portal -- sin Assignments/Time Entries (un
// Candidate todavía no tiene ninguno de los dos).
export const CANDIDATE_NAV: NavItem[] = [
  { to: "/portal/candidate", label: "Profile", icon: User, end: true },
  { to: "/portal/candidate/applications", label: "Applications", icon: Briefcase },
  { to: "/portal/candidate/onboarding", label: "Onboarding", icon: FolderCheck },
  { to: "/portal/candidate/documents", label: "Documents", icon: FileText },
  { to: "/portal/candidate/audit-log", label: "Audit Trail", icon: History },
];

function SidebarContent({
  brandName,
  items,
  portalLabel,
  onNavigate,
  collapsed = false,
}: {
  brandName?: string;
  items: NavItem[];
  portalLabel: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const fullLabel = brandName ? `${brandName} ${portalLabel}` : portalLabel;
  return (
    <>
      <div className={cn("flex min-h-14 items-center gap-2 border-b border-border py-2", collapsed ? "justify-center px-2" : "px-4")}>
        <img src="/logo-icon.png" alt="" title={collapsed ? fullLabel : undefined} className="h-7 w-auto shrink-0" />
        {/* F17: sin `truncate` a propósito -- "DreiStaff Candidate Portal"
            no entra en una línea a este ancho, y truncar mostraría "…"
            justo al lado del logo (exactamente lo que no queremos). Deja
            que ajuste a 2 líneas en vez de cortar el texto. */}
        {!collapsed && <span className="text-sm font-semibold leading-tight">{fullLabel}</span>}
      </div>
      <nav
        className={cn("flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden p-2", collapsed && "px-2")}
        aria-label={`${portalLabel} navigation`}
      >
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
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
      </nav>
    </>
  );
}

/**
 * F10.10: en mobile el `<aside>` estático quedaba `hidden` sin ninguna
 * navegación alternativa -- un Worker/Client/Candidate en un teléfono
 * literalmente no podía cambiar de página. Ahora `open`/`onClose`
 * controlan un off-canvas real (focus movido al panel al abrir,
 * Escape cierra, backdrop cierra, cada click de nav cierra) -- el
 * `<aside>` de escritorio (`md:flex`) sigue exactamente igual.
 */
export function PortalSidebar({
  brandName,
  items,
  portalLabel,
  open,
  onClose,
}: {
  brandName?: string;
  items: NavItem[];
  portalLabel: string;
  open: boolean;
  onClose: () => void;
}) {
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
    <>
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <SidebarContent brandName={brandName} items={items} portalLabel={portalLabel} collapsed={collapsed} />
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

      {open && (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label={`${portalLabel} navigation`}>
          <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
          <div className="relative flex h-full w-64 flex-col bg-card shadow-xl">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onClose}
              className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarContent brandName={brandName} items={items} portalLabel={portalLabel} onNavigate={onClose} />
          </div>
        </div>
      )}
    </>
  );
}
