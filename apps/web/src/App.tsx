import { Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { useCurrentUser } from "@/lib/useCurrentUser";

/**
 * F10.2: un usuario de portal (companyId/workerId/candidateId resuelto,
 * ver F10.1) NUNCA renderiza el shell interno -- se redirige a su
 * propio portal apenas se conoce su identidad real (GET /auth/me, ya
 * resuelto por RequireAuth antes de llegar acá). El backend igual
 * rechazaría cada endpoint interno sin el permiso correspondiente (ver
 * la exclusión exhaustiva verificada en portal-identity.test.ts) -- este
 * redirect es UX, nunca la única barrera de seguridad.
 */
export default function App() {
  const { data: user } = useCurrentUser();

  if (user?.companyId) return <Navigate to="/portal/client" replace />;

  return <AppShell />;
}
