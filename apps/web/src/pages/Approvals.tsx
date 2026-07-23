import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequestListItem } from "@ai-staffing-os/shared";
import { findKnownPlaceholders, isEditableApprovalStatus } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatStatusLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

// F21 Fase 4: READY_TO_SEND/FAILED agregados -- separación aprobación/
// envío. APPROVED se mantiene en la lista solo por compatibilidad con
// filas históricas (de antes de este cambio, cuando aprobar enviaba de
// inmediato) -- ninguna fila nueva queda descansando ahí.
const STATUS_TABS = ["PENDING", "READY_TO_SEND", "SENT", "FAILED", "REJECTED", "ALL"] as const;

const STATUS_BADGE_VARIANT: Record<string, "warning" | "success" | "danger" | "info"> = {
  PENDING: "warning",
  APPROVED: "info",
  READY_TO_SEND: "info",
  SENDING: "info",
  SENT: "success",
  FAILED: "danger",
  REJECTED: "danger",
  EXPIRED: "danger",
};

function ApprovalCard({ approval }: { approval: ApprovalRequestListItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState({ to: "", subject: "", body: "" });
  const [fieldErrors, setFieldErrors] = useState<{ to?: string; subject?: string; body?: string }>({});

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
    // F21 Fase 3: presente en los borradores generados por
    // personalizeMessage desde este cambio -- el canal real que resolvió
    // el destinatario (ver contact-channel.ts).
    contactChannelSource?: string;
  };

  const canEdit = isEditableApprovalStatus(approval.status);
  // F23: feedback inmediato mientras se edita, usando el mismo cuerpo que
  // está por guardarse -- el backend igual vuelve a validar al aprobar.
  const livePlaceholders = isEditing ? findKnownPlaceholders(draft.body) : (approval.placeholderWarning?.matches ?? []);

  const startEditing = () => {
    setDraft({ to: action.to ?? "", subject: action.subject ?? "", body: action.body ?? "" });
    setFieldErrors({});
    setIsEditing(true);
  };
  const cancelEditing = () => {
    setIsEditing(false);
    setFieldErrors({});
  };

  const editDraft = useMutation({
    mutationFn: (input: { to: string; subject: string; body: string }) =>
      apiFetch<ApprovalRequestListItem>(`/approvals/${approval.id}/draft`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => {
      setIsEditing(false);
      setFieldErrors({});
      toast({
        title: "Borrador actualizado",
        description:
          result.status === "PENDING" && approval.status === "READY_TO_SEND"
            ? "Vuelve a estado Pendiente — requiere una nueva aprobación."
            : "Los cambios se guardaron correctamente.",
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => toast({ title: "No se pudo guardar el borrador", description: String(err), variant: "error" }),
  });

  const handleSaveDraft = () => {
    const errors: typeof fieldErrors = {};
    const to = draft.to.trim();
    const subject = draft.subject.trim();
    const body = draft.body.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) errors.to = "Ingresa un email válido.";
    if (!subject) errors.subject = "El asunto no puede estar vacío.";
    if (!body) errors.body = "El cuerpo no puede estar vacío.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    editDraft.mutate({ to, subject, body });
  };

  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") =>
      apiFetch<ApprovalRequestListItem>(`/approvals/${approval.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSuccess: (result) => {
      // F21 Fase 4: decidir NUNCA envía nada -- APPROVED solo deja el
      // borrador en READY_TO_SEND, listo para el botón "Enviar" separado
      // de abajo. Nunca se muestra un toast de "email enviado" acá.
      toast({
        title: result.status === "READY_TO_SEND" ? "Aprobado — listo para enviar" : "Decisión registrada",
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => toast({ title: "No se pudo registrar la decisión", description: String(err), variant: "error" }),
  });

  // F21 Fase 4: única acción que realmente envía un email -- separada a
  // propósito de "decide", requiere status READY_TO_SEND o FAILED
  // (reintento) en el backend (sendApproval, approvals/service.ts), que
  // además garantiza idempotencia real (nunca un doble envío aunque se
  // haga doble clic).
  const send = useMutation({
    mutationFn: () => apiFetch<ApprovalRequestListItem>(`/approvals/${approval.id}/send`, { method: "POST" }),
    onSuccess: (result) => {
      const r = result.emailSendResult;
      if (r?.status === "SENT") {
        toast({ title: "Email enviado", description: `Confirmado por Microsoft Graph (id ${r.providerMessageId ?? "—"}).`, variant: "success" });
      } else if (r) {
        toast({
          title: r.status === "RETRYABLE" ? "Email no enviado (reintentable)" : "Email no enviado",
          description: r.errorMessage ?? "Error desconocido del proveedor.",
          variant: "error",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => toast({ title: "No se pudo enviar", description: String(err), variant: "error" }),
  });

  const handleSend = () => {
    // El botón "Enviar" es la única acción de todo este flujo que
    // dispara un correo real e irreversible -- confirmación explícita
    // antes de disparar el request, nunca un solo clic accidental.
    if (window.confirm(`¿Enviar este email a "${action.to ?? "el destinatario resuelto"}" ahora? Esta acción no se puede deshacer.`)) {
      send.mutate();
    }
  };

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
          <Badge variant={STATUS_BADGE_VARIANT[approval.status] ?? "warning"}>{formatStatusLabel(approval.status)}</Badge>
        </div>
        {!isEditing && action.to && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Para: {action.to}</span>
            {/* F15: nunca se disfraza un email de departamento como si
                fuera una persona real -- explícito acá, en la misma
                pantalla donde un humano decide aprobar o no el envío. */}
            {action.recipientKind === "organizational" && <Badge variant="info">Contacto organizacional</Badge>}
            {action.recipientKind === "person" && <Badge variant="success">Persona identificada</Badge>}
            {action.contactChannelSource && <Badge variant="info">Canal: {action.contactChannelSource}</Badge>}
          </p>
        )}

        {/* F23 Fase 5: advertencia NO bloqueante -- nunca sustituye ni
            corrige el destinatario automáticamente, solo pide verificarlo. */}
        {!isEditing && approval.recipientWarning?.suspicious && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            <p className="font-medium">Destinatario a verificar antes de aprobar:</p>
            <ul className="ml-4 list-disc">
              {approval.recipientWarning.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* F23 Fase 4: bloquea explícitamente la aprobación mientras haya
            placeholders de firma sin completar -- nunca se reemplazan solos. */}
        {livePlaceholders.length > 0 && (
          <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            <p className="font-medium">Este borrador tiene placeholders sin completar: {livePlaceholders.join(", ")}</p>
            <p>Corrígelos antes de aprobar.</p>
          </div>
        )}

        {!isEditing && (
          <>
            {action.subject && <p className="font-medium">{action.subject}</p>}
            {action.body && <p className="whitespace-pre-wrap text-muted-foreground">{action.body}</p>}
          </>
        )}

        {isEditing && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <Label htmlFor={`to-${approval.id}`}>Para</Label>
              <Input
                id={`to-${approval.id}`}
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                placeholder="destinatario@empresa.com"
              />
              {fieldErrors.to && <p className="mt-1 text-xs text-danger">{fieldErrors.to}</p>}
            </div>
            <div>
              <Label htmlFor={`subject-${approval.id}`}>Asunto</Label>
              <Input
                id={`subject-${approval.id}`}
                value={draft.subject}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              />
              {fieldErrors.subject && <p className="mt-1 text-xs text-danger">{fieldErrors.subject}</p>}
            </div>
            <div>
              <Label htmlFor={`body-${approval.id}`}>Cuerpo</Label>
              <Textarea
                id={`body-${approval.id}`}
                rows={8}
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              />
              {fieldErrors.body && <p className="mt-1 text-xs text-danger">{fieldErrors.body}</p>}
            </div>
            {approval.status === "READY_TO_SEND" && (
              <p className="text-xs text-muted-foreground">
                Este borrador ya estaba aprobado — al guardar volverá a Pendiente y necesitará una nueva aprobación.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" disabled={editDraft.isPending} onClick={handleSaveDraft}>
                Guardar cambios
              </Button>
              <Button size="sm" variant="outline" disabled={editDraft.isPending} onClick={cancelEditing}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {!isEditing && canEdit && (
          <div className="pt-1">
            <Button size="sm" variant="outline" onClick={startEditing}>
              Editar borrador
            </Button>
          </div>
        )}

        {!isEditing && approval.status === "PENDING" && (
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              disabled={decide.isPending || livePlaceholders.length > 0}
              onClick={() => decide.mutate("APPROVED")}
            >
              Aprobar
            </Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("REJECTED")}>
              Rechazar
            </Button>
          </div>
        )}

        {!isEditing && approval.status === "READY_TO_SEND" && (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={send.isPending} onClick={handleSend}>
              Enviar
            </Button>
            <span className="text-xs text-muted-foreground">Aprobado — pendiente de tu confirmación explícita para enviar.</span>
          </div>
        )}

        {!isEditing && approval.status === "FAILED" && (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={send.isPending} onClick={handleSend}>
              Reintentar envío
            </Button>
            <span className="text-xs text-danger">El intento de envío anterior falló — nunca se reintenta automáticamente.</span>
          </div>
        )}

        {approval.status === "SENT" && (
          <p className="text-xs text-muted-foreground">
            Enviado{approval.sentByLabel ? ` por ${approval.sentByLabel}` : ""}
            {approval.sentAt ? ` el ${new Date(approval.sentAt).toLocaleString()}` : ""}.
          </p>
        )}

        {(approval.status === "REJECTED" || approval.status === "EXPIRED" || approval.status === "APPROVED") &&
          approval.decidedByLabel && (
            <p className="text-xs text-muted-foreground">
              Decidido por {approval.decidedByLabel}
              {approval.decisionNote ? ` — "${approval.decisionNote}"` : ""}
            </p>
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
