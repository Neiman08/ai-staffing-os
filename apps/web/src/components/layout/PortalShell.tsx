import { Outlet } from "react-router-dom";
import { PortalSidebar, type NavItem } from "@/components/layout/PortalSidebar";
import { PortalTopbar } from "@/components/layout/PortalTopbar";
import { DevBanner } from "@/components/layout/DevBanner";
import { useBranding, useDocumentTitleFromBranding } from "@/lib/branding";

/**
 * F10.2/F10.4: shell de portal -- visualmente distinguible del
 * backoffice interno (mismo criterio ya pedido explícitamente por el
 * PO). Reusa DevBanner/ThemeToggle/UserMenu (infraestructura
 * transversal ya probada), nunca duplica lógica de auth -- RequireAuth
 * ya resolvió la sesión antes de llegar acá. `items`/`portalLabel`
 * parametrizan el shell para los 3 tipos de portal (Client/Worker/
 * Candidate) sin triplicar este componente.
 */
export function PortalShell({ items, portalLabel }: { items: NavItem[]; portalLabel: string }) {
  const { data: branding } = useBranding();
  useDocumentTitleFromBranding(branding?.brandName ? `${branding.brandName} ${portalLabel}` : undefined);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <DevBanner />
      <div className="flex min-h-0 flex-1">
        <PortalSidebar brandName={branding?.brandName} items={items} portalLabel={portalLabel} />
        <div className="flex min-w-0 flex-1 flex-col">
          <PortalTopbar />
          <main className="flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
