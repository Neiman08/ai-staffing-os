import { Navigate } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { useCurrentUser } from "@/lib/useCurrentUser";

/**
 * F10.2: guarda simétrica a la de App.tsx -- alguien SIN companyId
 * (personal interno, o un futuro Worker/Candidate de F10.4) nunca debe
 * quedarse en el shell de Client Portal. El backend igual rechazaría
 * cada endpoint /portal/client/* sin portalAssignments.view (ver
 * portal-identity.test.ts), esto es solo UX. `PortalShell` ya renderiza
 * su propio `<Outlet/>` -- no se le pasan children.
 */
export function ClientPortalGate() {
  const { data: user } = useCurrentUser();

  if (user && !user.companyId) return <Navigate to="/" replace />;

  return <PortalShell />;
}
