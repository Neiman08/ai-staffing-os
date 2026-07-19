import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusScreen } from "./StatusScreen";

/**
 * F14: distingue "no pude ni hablar con el backend" (fetch tiró, o
 * respondió algo que no es el JSON de error esperado -- ej. VITE_API_URL
 * mal configurado en el build del frontend, así que un fetch relativo a
 * "/api/v1/..." termina pegándole al propio sitio estático, que
 * devuelve el index.html de la SPA en vez de la API real) de "el
 * backend respondió y me rechazó" (eso es Unauthorized/Forbidden/etc.,
 * un ApiError real). Mezclar ambos bajo "Session required" es
 * engañoso: acá ni siquiera hay una respuesta de auth que evaluar.
 */
export function ConnectionError({ detail }: { detail?: string }) {
  return (
    <StatusScreen
      icon={<WifiOff className="h-10 w-10 text-destructive" />}
      title="Can't reach the server"
      description={
        detail ??
        "The app couldn't get a valid response from the API. This usually means the frontend's API URL is misconfigured, not that you're signed out."
      }
      action={<Button onClick={() => window.location.reload()}>Retry</Button>}
    />
  );
}
