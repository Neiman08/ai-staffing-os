import { useState } from "react";
import { cn } from "@/lib/utils";

interface PhotoProps {
  src: string;
  alt: string;
  className?: string;
  overlay?: "none" | "dark" | "gradient";
  priority?: boolean;
}

/**
 * F4.8A: única forma de renderizar fotografía en el sitio — si la URL
 * falla (red, hotlink caído, etc.) nunca se ve un ícono de imagen rota:
 * el fondo --ink de este wrapper queda visible solo, un bloque sólido
 * que sigue leyéndose intencional. Nunca requiere un fallback local
 * adicional por imagen.
 */
export function Photo({ src, alt, className, overlay = "none", priority = false }: PhotoProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={cn("relative overflow-hidden bg-ink", className)}>
      {!failed && (
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
      {overlay === "dark" && <div className="absolute inset-0 bg-ink/55" aria-hidden />}
      {overlay === "gradient" && (
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/50 to-transparent" aria-hidden />
      )}
    </div>
  );
}
