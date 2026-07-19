import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * F12.10: catch-all real para cualquier URL que no matchea ninguna
 * ruta conocida -- antes de esto, react-router simplemente no
 * renderizaba nada (pantalla en blanco), nunca un 404 real explicado.
 * Enlace a "/" siempre seguro: App.tsx ya redirige a cada identidad
 * (interna o de portal) a su propio home real.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <AlertTriangle className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-xl font-semibold">Página no encontrada</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        La URL que intentaste abrir no existe o ya no está disponible.
      </p>
      <Link to="/" className="text-sm font-medium text-primary hover:underline">
        Volver al inicio
      </Link>
    </div>
  );
}
