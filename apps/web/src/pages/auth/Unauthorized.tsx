import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusScreen } from "./StatusScreen";
import { CLERK_CONFIGURED } from "@/lib/auth-config";

/**
 * F14: en AUTH_MODE=dev-bypass no existe ningún flujo de "sign in" —
 * la copia genérica "Session required / You need to sign in" (pensada
 * para Clerk) es directamente engañosa acá: implica que falta iniciar
 * sesión cuando el problema real es que GET /auth/me falló (ej. el
 * usuario de dev-bypass no existe todavía en esta base de datos —
 * hallazgo real del primer deploy a Render, donde la base nunca se
 * sembró). `message` (el mensaje real del backend, ver ApiError) se
 * muestra tal cual cuando está disponible, para que quien vea esta
 * pantalla en dev-bypass tenga la causa real, no una adivinanza.
 */
export function Unauthorized({ message }: { message?: string } = {}) {
  return (
    <StatusScreen
      icon={<LockKeyhole className="h-10 w-10 text-muted-foreground" />}
      title={CLERK_CONFIGURED ? "Session required" : "Access denied (dev-bypass)"}
      description={
        message ??
        (CLERK_CONFIGURED
          ? "You need to sign in to access this application."
          : "The backend rejected this identity. Check server logs / DEV_DEFAULT_USER_EMAIL and that the tenant is seeded.")
      }
      action={
        CLERK_CONFIGURED ? (
          <Button onClick={() => (window.location.href = "/sign-in")}>Go to sign in</Button>
        ) : undefined
      }
    />
  );
}
