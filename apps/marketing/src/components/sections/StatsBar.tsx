import { useEffect, useState } from "react";
import type { PublicStats } from "@ai-staffing-os/shared";
import { publicApiFetch } from "@/lib/api";
import { Container } from "@/components/ui/Container";
import { Photo } from "@/components/ui/Photo";
import { PHOTOS } from "@/lib/photos";

// F4.8/F4.8A: SOLO números reales de /public/stats — nunca un
// placeholder "10,000+" inventado. Mientras carga, no se muestra nada
// (mejor un hueco breve que un número falso). El rediseño solo agrega
// una foto de fondo con overlay oscuro detrás de los mismos números.
export function StatsBar() {
  const [stats, setStats] = useState<PublicStats | null>(null);

  useEffect(() => {
    publicApiFetch<PublicStats>("/stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) return null;

  const items = [
    { label: "Industries served", value: stats.industriesServed },
    { label: "States covered", value: stats.statesActive },
    { label: "Employers in our network", value: stats.companiesInNetwork },
    { label: "AI agents at work", value: stats.aiAgentsActive },
  ];

  return (
    <div className="relative isolate overflow-hidden">
      <Photo
        src={PHOTOS.dataCenterServerRoom.src}
        alt=""
        overlay="dark"
        className="absolute inset-0 -z-10 h-full w-full"
      />
      <div className="absolute inset-0 -z-10 bg-ink/70" aria-hidden />
      <Container className="grid grid-cols-2 gap-8 py-16 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="text-center">
            <p className="text-3xl font-extrabold tabular-nums text-white sm:text-4xl">{item.value}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-white/60">{item.label}</p>
          </div>
        ))}
      </Container>
    </div>
  );
}
