import { SignUp } from "@clerk/clerk-react";

/**
 * F4.9: el portal es invite-only (ver docs/F4_9_PRODUCTION_AUTH_PLAN.md
 * §5 — "cualquier usuario adicional debe crearse mediante invitación
 * explícita"). Esta ruta existe para que el link de invitación de Clerk
 * tenga dónde aterrizar (completar contraseña/perfil), no para
 * self-service sign-up — no se linkea desde ningún botón público.
 */
export function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </div>
  );
}
