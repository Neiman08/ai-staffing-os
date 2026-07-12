import { ShieldAlert, ShieldCheck } from "lucide-react";
import { StatusScreen } from "./StatusScreen";

/**
 * F4.9: distingue explícitamente el caso "MFA requerido" (código
 * MFA_REQUIRED del backend, F4.9-8) de un 403 genérico de permisos —
 * son situaciones accionables distintas para el usuario.
 */
export function Forbidden({ code }: { code?: string }) {
  if (code === "MFA_REQUIRED") {
    return (
      <StatusScreen
        icon={<ShieldCheck className="h-10 w-10 text-amber-500" />}
        title="Two-factor authentication required"
        description="Your role requires MFA to be enabled before you can continue. Set it up from your account security settings."
      />
    );
  }

  return (
    <StatusScreen
      icon={<ShieldAlert className="h-10 w-10 text-destructive" />}
      title="Access denied"
      description="You don't have permission to access this resource. Contact your administrator if you believe this is a mistake."
    />
  );
}
