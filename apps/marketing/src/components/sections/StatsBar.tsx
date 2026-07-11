import { useEffect, useState } from "react";
import type { PublicStats } from "@ai-staffing-os/shared";
import { publicApiFetch } from "@/lib/api";
import { Container } from "@/components/ui/Container";

// F4.8: SOLO números reales de /public/stats — nunca un placeholder
// "10,000+" inventado. Mientras carga, no se muestra nada (mejor un
// hueco breve que un número falso).
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
    <div className="border-y border-border bg-muted/40">
      <Container className="grid grid-cols-2 gap-8 py-10 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="text-center">
            <p className="text-3xl font-extrabold tabular-nums text-foreground sm:text-4xl">{item.value}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</p>
          </div>
        ))}
      </Container>
    </div>
  );
}
