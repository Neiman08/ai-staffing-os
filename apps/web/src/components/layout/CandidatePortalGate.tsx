import { Navigate } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { CANDIDATE_NAV } from "@/components/layout/PortalSidebar";
import { useCurrentUser } from "@/lib/useCurrentUser";

// F10.4: mismo criterio que ClientPortalGate -- redirige fuera a quien no tenga candidateId.
export function CandidatePortalGate() {
  const { data: user } = useCurrentUser();

  if (user && !user.candidateId) return <Navigate to="/" replace />;

  return <PortalShell items={CANDIDATE_NAV} portalLabel="Candidate Portal" />;
}
