import { useCurrentUser } from "@/lib/useCurrentUser";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { UserMenu } from "@/components/layout/UserMenu";

// F10.2: sin la barra de búsqueda ni la campana de notificaciones
// internas (/dashboard/notifications, sistema de F1 -- no pensado para
// portales). La campana real de portal llega en F10.8 (PortalNotification,
// F10.1 §clientJobs/portal*).
export function PortalTopbar() {
  const { data: user } = useCurrentUser();

  return (
    <header className="flex h-14 items-center justify-end gap-4 border-b border-border px-4">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
