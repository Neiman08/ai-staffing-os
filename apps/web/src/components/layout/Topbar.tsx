import { Bell, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

interface CurrentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

interface NotificationsSummary {
  unreadCount: number;
}

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

export function Topbar() {
  const { data: user } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<CurrentUser>("/auth/me"),
  });

  const { data: notifications } = useQuery({
    queryKey: ["dashboard", "notifications"],
    queryFn: () => apiFetch<NotificationsSummary>("/dashboard/notifications"),
    refetchInterval: 30_000,
  });

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4">
      <div className="flex max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-sm text-muted-foreground">
        <Search className="h-4 w-4" />
        <span>Buscar (⌘K próximamente)</span>
      </div>

      <div className="flex items-center gap-2">
        <ThemeToggle />

        <button
          type="button"
          aria-label="Notificaciones"
          className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Bell className="h-4 w-4" />
          {!!notifications?.unreadCount && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {notifications.unreadCount}
            </span>
          )}
        </button>

        <div className="flex items-center gap-2 pl-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {user ? initials(user.firstName, user.lastName) : "…"}
          </div>
          <div className="hidden text-xs leading-tight sm:block">
            <div className="font-medium">{user ? `${user.firstName} ${user.lastName}` : "Cargando…"}</div>
            <div className="text-muted-foreground">{user?.role}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
