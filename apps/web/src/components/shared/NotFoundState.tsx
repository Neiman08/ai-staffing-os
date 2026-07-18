import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * F10.11: hallazgo real de e2e -- 6 páginas de detalle de portal
 * (Job Order/Job Request/Profile/Onboarding, client/worker/candidate)
 * mostraban "Cargando…" para SIEMPRE cuando la query fallaba (404 por
 * ownership, red caída, etc.) -- `isLoading || !data` nunca distinguía
 * "todavía cargando" de "falló, sin dato". Corregido una sola vez acá.
 */
export function NotFoundState({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">No se encontró este recurso, o no tienes acceso a él.</p>
      <Link to={backHref} className="text-sm font-medium text-primary hover:underline">
        {backLabel}
      </Link>
    </div>
  );
}
