import { SignIn } from "@clerk/clerk-react";

/**
 * F4.9: componente prearmado de Clerk — cubre email+password, magic
 * link y Google (si están habilitados en el dashboard de Clerk, ver
 * docs/F4_9_PRODUCTION_AUTH_PLAN.md), verificación de email y
 * recuperación de contraseña, todo de fábrica. routing="path" porque
 * el portal usa React Router (SPA), no el router de Next.js.
 */
export function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </div>
  );
}
