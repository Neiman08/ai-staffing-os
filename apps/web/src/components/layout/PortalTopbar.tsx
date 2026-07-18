import { Menu } from "lucide-react";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { UserMenu } from "@/components/layout/UserMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";

// F10.2: sin la barra de búsqueda (no aplica a portal). F10.8: campana
// real -- mismos endpoints `/notifications*` que el shell interno, ya
// scope-eados por userId en el backend (nunca recipientRole para roles
// de portal, ver core/notifications.ts). F10.10: botón hamburguesa
// (solo mobile) para abrir el nav off-canvas de PortalSidebar.
export function PortalTopbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { data: user } = useCurrentUser();

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4 md:justify-end">
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onOpenNav}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <NotificationBell />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
