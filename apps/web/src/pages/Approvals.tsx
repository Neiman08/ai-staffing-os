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
  const action = approval.proposedAction as {
    channel?: string;
    leadId?: string;
    subject?: string;
    body?: string;
    to?: string;
    // F15: "person" cuando hay un Contact real identificado, "organizational"
    // cuando el destinatario es un email de departamento (info@/hr@/careers@)
    // -- ausente en approvals generados antes de este fix.
    recipientKind?: "person" | "organizational";
  };

  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") =>
      apiFetch<ApprovalRequestListItem>(`/approvals/${approval.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSuccess: (result) => {
      // F17: emailSendResult solo viene poblado en la respuesta directa
      // de este POST (nunca en el listado) -- es el único momento real
      // en que se sabe si Microsoft Graph confirmó el envío, así que se
      // muestra acá mismo, nunca se inventa un "enviado" optimista.
      if (result.emailSendResult) {
        const r = result.emailSendResult;
        if (r.status === "SENT") {
          toast({ title: "Email enviado", description: `Confirmado por Microsoft Graph (id ${r.providerMessageId ?? "—"}).`, variant: "success" });
        } else {
          toast({
            title: r.status === "RETRYABLE" ? "Email no enviado (reintentable)" : "Email no enviado",
            description: r.errorMessage ?? "Error desconocido del proveedor.",
            variant: "error",
          });
        }
      } else {
        toast({ title: "Decisión registrada", variant: "success" });
      }
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
        {action.to && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Para: {action.to}</span>
            {/* F15: nunca se disfraza un email de departamento como si
                fuera una persona real -- explícito acá, en la misma
                pantalla donde un humano decide aprobar o no el envío. */}
            {action.recipientKind === "organizational" && <Badge variant="info">Contacto organizacional</Badge>}
            {action.recipientKind === "person" && <Badge variant="success">Persona identificada</Badge>}
          </p>
        )}
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
