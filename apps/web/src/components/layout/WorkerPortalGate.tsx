import { Navigate } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { WORKER_NAV } from "@/components/layout/PortalSidebar";
import { useCurrentUser } from "@/lib/useCurrentUser";

// F10.4: mismo criterio que ClientPortalGate -- redirige fuera a quien no tenga workerId.
export function WorkerPortalGate() {
  const { data: user } = useCurrentUser();

  if (user && !user.workerId) return <Navigate to="/" replace />;

  return <PortalShell items={WORKER_NAV} portalLabel="Worker Portal" />;
}
