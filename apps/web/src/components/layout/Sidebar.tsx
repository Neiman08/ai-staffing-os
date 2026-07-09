import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Building2,
  Briefcase,
  Users,
  ShieldCheck,
  Wallet,
  TrendingUp,
  Bot,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/companies", label: "Companies", icon: Building2 },
  { to: "/job-orders", label: "Job Orders", icon: Briefcase },
  { to: "/candidates", label: "Candidates", icon: Users },
  { to: "/compliance", label: "Compliance", icon: ShieldCheck },
  { to: "/payroll", label: "Payroll", icon: Wallet },
  { to: "/pricing", label: "Pricing", icon: TrendingUp },
  { to: "/agents", label: "AI Agents Center", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-card/40 md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          A
        </div>
        <span className="text-sm font-semibold">AI Staffing OS</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
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
