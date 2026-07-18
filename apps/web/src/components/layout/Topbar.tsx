import { Search } from "lucide-react";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { UserMenu } from "@/components/layout/UserMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export function Topbar() {
  const { data: user } = useCurrentUser();

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4">
      <div className="flex max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-sm text-muted-foreground">
        <Search className="h-4 w-4" />
        <span>Buscar (⌘K próximamente)</span>
      </div>

      <div className="flex items-center gap-2">
        <ThemeToggle />
        <NotificationBell />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
