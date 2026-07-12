import { UserButton } from "@clerk/clerk-react";
import type { CurrentUser } from "@ai-staffing-os/shared";
import { CLERK_CONFIGURED } from "@/lib/auth-config";

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

/**
 * F4.9 §7: componente prearmado de Clerk — su menú "Manage account"
 * abre <UserProfile/> en un modal (perfil, seguridad, MFA setup) sin
 * código propio; "Sign out" ya llama a signOut() internamente. En
 * dev-bypass (sin Clerk configurado) no hay sesión real de la que
 * salir, así que se mantiene el bloque estático de siempre.
 */
export function UserMenu({ user }: { user: CurrentUser | undefined }) {
  if (CLERK_CONFIGURED) {
    return (
      <div className="flex items-center gap-2 pl-1">
        <UserButton afterSignOutUrl="/sign-in" />
        <div className="hidden text-xs leading-tight sm:block">
          <div className="font-medium">{user ? `${user.firstName} ${user.lastName}` : "…"}</div>
          <div className="text-muted-foreground">{user?.role.name}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 pl-1">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {user ? initials(user.firstName, user.lastName) : "…"}
      </div>
      <div className="hidden text-xs leading-tight sm:block">
        <div className="font-medium">{user ? `${user.firstName} ${user.lastName}` : "Cargando…"}</div>
        <div className="text-muted-foreground">{user?.role.name}</div>
      </div>
    </div>
  );
}
