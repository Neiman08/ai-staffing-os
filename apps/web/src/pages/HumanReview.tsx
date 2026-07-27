import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HumanReviewRequestListItem, HumanReviewPriorityValue } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * F25.2 (consolidación): Human Review Center -- reusa el patrón visual
 * de Approvals.tsx (PageHeader, tabs de estado, Card por caso, Badge de
 * estado/prioridad, useMutation+useToast para la acción) contra los
 * endpoints reales de F25.2 Fase 5 (GET/POST /api/v1/human-review).
 */

const STATUS_TABS = ["OPEN", "RESOLVED", "ALL"] as const;

const PRIORITY_BADGE_VARIANT: Record<HumanReviewPriorityValue, "danger" | "warning" | "info" | "neutral"> = {
  URGENT: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

function HumanReviewCard({ request }: { request: HumanReviewRequestListItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isResolving, setIsResolving] = useState(false);
  const [resolution, setResolution] = useState("");

  const resolve = useMutation({
    mutationFn: () => apiFetch<HumanReviewRequestListItem>(`/human-review/${request.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) }),
    onSuccess: () => {
      setIsResolving(false);
      setResolution("");
      toast({ title: "Caso resuelto", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["human-review"] });
    },
    onError: (err) => toast({ title: "No se pudo resolver el caso", description: String(err), variant: "error" }),
  });

  const isResolved = request.resolvedAt !== null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="font-medium">{request.summary}</span>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Badge variant={PRIORITY_BADGE_VARIANT[request.priority]}>{formatStatusLabel(request.priority)}</Badge>
            <Badge variant="neutral">{formatStatusLabel(request.type)}</Badge>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {request.entityType} · {request.entityId}
          {request.deadline && ` · vence ${new Date(request.deadline).toLocaleString()}`}
        </p>

        <div className="rounded-md border border-border p-2.5 text-xs">
          <p className="font-medium">Decisión solicitada</p>
          <p className="mt-0.5 text-muted-foreground">{request.requestedDecision}</p>
        </div>

        {request.evidence.length > 0 && (
          <div className="rounded-md border border-border p-2.5 text-xs">
            <p className="font-medium">Evidencia ({request.evidence.length})</p>
            <ul className="mt-1 space-y-1">
              {request.evidence.map((item, i) => (
                <li key={i} className="text-muted-foreground">
                  {Object.entries(item)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </li>
              ))}
            </ul>
          </div>
        )}

        {request.options.length > 0 && (
          <div className="rounded-md border border-border p-2.5 text-xs">
            <p className="font-medium">Opciones</p>
            <ul className="mt-1 space-y-1">
              {request.options.map((opt, i) => (
                <li key={i}>
                  <span className="font-medium">{opt.label}</span> — <span className="text-muted-foreground">{opt.consequence}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {request.recommendation && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Sugerencia del sistema (no vinculante): </span>
            {request.recommendation}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Impacto si no se decide: </span>
          {request.impact}
        </p>

        {!isResolved && !isResolving && (
          <div className="pt-1">
            <Button size="sm" onClick={() => setIsResolving(true)}>
              Resolver
            </Button>
          </div>
        )}

        {!isResolved && isResolving && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <Textarea
              rows={3}
              placeholder="Describe la decisión tomada..."
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={resolve.isPending || !resolution.trim()} onClick={() => resolve.mutate()}>
                Confirmar resolución
              </Button>
              <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => setIsResolving(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {isResolved && (
          <p className="text-xs text-muted-foreground">
            Resuelto el {new Date(request.resolvedAt!).toLocaleString()}
            {request.resolution ? ` — "${request.resolution}"` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function HumanReview() {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]>("OPEN");

  const { data: requests, isLoading } = useQuery({
    queryKey: ["human-review", statusFilter],
    queryFn: () => apiFetch<HumanReviewRequestListItem[]>(`/human-review${statusFilter !== "ALL" ? `?status=${statusFilter}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Human Review Center"
        description="Casos que un agente escaló para decisión humana -- con evidencia, opciones y una sugerencia no vinculante. Nunca se resuelven solos."
      />

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {STATUS_TABS.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "ghost"}
            size="sm"
            onClick={() => setStatusFilter(s)}
            className={cn(statusFilter !== s && "text-muted-foreground")}
          >
            {s === "ALL" ? "Todos" : s === "OPEN" ? "Abiertos" : "Resueltos"}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : requests && requests.length > 0 ? (
        <div className="space-y-3">
          {requests.map((r) => (
            <HumanReviewCard key={r.id} request={r} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sin casos en este estado.</p>
      )}
    </div>
  );
}
