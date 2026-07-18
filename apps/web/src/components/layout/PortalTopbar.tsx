import { useCurrentUser } from "@/lib/useCurrentUser";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { UserMenu } from "@/components/layout/UserMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";

// F10.2: sin la barra de búsqueda (no aplica a portal). F10.8: campana
// real -- mismos endpoints `/notifications*` que el shell interno, ya
// scope-eados por userId en el backend (nunca recipientRole para roles
// de portal, ver core/notifications.ts).
export function PortalTopbar() {
  const { data: user } = useCurrentUser();

  return (
    <header className="flex h-14 items-center justify-end gap-4 border-b border-border px-4">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <NotificationBell />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
