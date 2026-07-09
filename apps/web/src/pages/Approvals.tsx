import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequestListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatStatusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

const STATUS_TABS = ["PENDING", "APPROVED", "REJECTED", "ALL"] as const;

function ApprovalCard({ approval }: { approval: ApprovalRequestListItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const action = approval.proposedAction as { channel?: string; leadId?: string; subject?: string; body?: string };

  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") =>
      apiFetch(`/approvals/${approval.id}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: () => {
      toast({ title: "Decisión registrada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => toast({ title: "No se pudo registrar la decisión", description: String(err), variant: "error" }),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-medium">{approval.summary}</span>
            {action.leadId && (
              <Link to={`/leads/${action.leadId}`} className="ml-2 text-xs text-primary hover:underline">
                Ver lead
              </Link>
            )}
          </div>
          <Badge
            variant={
              approval.status === "PENDING" ? "warning" : approval.status === "APPROVED" ? "success" : "danger"
            }
          >
            {formatStatusLabel(approval.status)}
          </Badge>
        </div>
        {action.subject && <p className="font-medium">{action.subject}</p>}
        {action.body && <p className="whitespace-pre-wrap text-muted-foreground">{action.body}</p>}
        {approval.status === "PENDING" ? (
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("APPROVED")}>
              Aprobar
            </Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("REJECTED")}>
              Rechazar
            </Button>
          </div>
        ) : (
          approval.decidedByLabel && (
            <p className="text-xs text-muted-foreground">
              Decidido por {approval.decidedByLabel}
              {approval.decisionNote ? ` — "${approval.decisionNote}"` : ""}
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

export default function Approvals() {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_TABS)[number]>("PENDING");

  const { data: approvals, isLoading } = useQuery({
    queryKey: ["approvals", statusFilter],
    queryFn: () =>
      apiFetch<ApprovalRequestListItem[]>(`/approvals${statusFilter !== "ALL" ? `?status=${statusFilter}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Borradores de outreach del Sales Agent pendientes de revisión humana — nunca se envían automáticamente."
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
            {s === "ALL" ? "Todas" : formatStatusLabel(s)}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : approvals && approvals.length > 0 ? (
        <div className="space-y-3">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sin aprobaciones en este estado.</p>
      )}
    </div>
  );
}
