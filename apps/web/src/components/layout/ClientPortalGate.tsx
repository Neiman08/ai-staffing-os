import { Navigate } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { CLIENT_NAV } from "@/components/layout/PortalSidebar";
import { useCurrentUser } from "@/lib/useCurrentUser";

/**
 * F10.2/F10.4: guarda simétrica a la de App.tsx -- alguien SIN
 * companyId (personal interno, Worker, o Candidate) nunca debe
 * quedarse en el shell de Client Portal. El backend igual rechazaría
 * cada endpoint /portal/client/* sin portalAssignments.view (ver
 * portal-identity.test.ts), esto es solo UX.
 */
export function ClientPortalGate() {
  const { data: user } = useCurrentUser();

  if (user && !user.companyId) return <Navigate to="/" replace />;

  return <PortalShell items={CLIENT_NAV} portalLabel="Portal" />;
}
