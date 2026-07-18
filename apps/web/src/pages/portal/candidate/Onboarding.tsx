import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type { CandidateOnboardingItem } from "./types";

export default function CandidateOnboardingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-candidate-onboarding"],
    queryFn: () => apiFetch<CandidateOnboardingItem[]>("/portal/candidate/onboarding"),
  });

  return (
    <div>
      <PageHeader title="Onboarding" description="Tu progreso de incorporación por Job Order." />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : data && data.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {data.map((o) => (
            <Card key={o.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{o.jobOrderTitle}</span>
                  <Badge variant={statusVariant(o.status)}>{formatStatusLabel(o.status)}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">Progreso: {o.progress}%</p>
                <p className="rounded border border-border bg-muted/40 p-2 text-xs">
                  <span className="font-medium">Próxima acción sugerida: </span>
                  {o.nextBestAction}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sin onboarding iniciado todavía.</p>
      )}
    </div>
  );
}
