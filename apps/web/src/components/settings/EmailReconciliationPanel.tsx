import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * F27 Fase 9: panel de administración real de trazabilidad de envíos --
 * detecta mensajes reales en Sent Items que Microsoft Graph acepta pero
 * ningún EmailMessage explica (envío fuera del flujo oficial, el hallazgo
 * original que motivó esta misión completa), y expone el estado real de
 * los proveedores de datos (PDL/Hunter) y de la entregabilidad (SPF/DKIM).
 */

interface ReconciliationAlert {
  id: string;
  mailbox: string;
  graphMessageId: string;
  internetMessageId: string | null;
  subject: string | null;
  toRecipients: string[];
  sentDateTime: string | null;
  discoveredAt: string;
  status: "OPEN" | "ACKNOWLEDGED" | "DISMISSED";
}

interface ReconciliationSummary {
  mailbox: string;
  sentItemsScanned: number;
  confirmedThisRun: number;
  alreadyConfirmed: number;
  bounced: number;
  untrackedAlertsCreated: number;
  untrackedAlertsAlreadyOpen: number;
  markedDeliveryUnknown: number;
  errors: string[];
}

interface ProviderStatus {
  microsoftGraph: { configured: boolean; healthy: boolean; reason: string | null };
  peopleDataLabs: { configured: boolean; circuitStatus: string; monthlyCreditBudget: number; creditsUsedThisMonth: number; remainingThisMonth: number };
  hunter: { configured: boolean; circuitStatus: string; domainsQueriedOrCachedThisMonth: number };
  deliverability: { degraded: boolean; spfPass: boolean; dkimPass: boolean; dmarcPolicy: string; lastVerifiedAt: string; detail: string };
}

function circuitBadge(status: string) {
  if (status === "AVAILABLE") return <Badge variant="success">Disponible</Badge>;
  if (status === "CREDIT_EXHAUSTED") return <Badge variant="danger">Créditos agotados</Badge>;
  if (status === "UNAUTHORIZED") return <Badge variant="danger">Credenciales inválidas</Badge>;
  return <Badge variant="warning">No disponible</Badge>;
}

export function EmailReconciliationPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const alerts = useQuery({
    queryKey: ["settings", "email-reconciliation-alerts"],
    queryFn: () => apiFetch<ReconciliationAlert[]>("/emails/reconciliation-alerts?status=OPEN"),
  });
  const providerStatus = useQuery({
    queryKey: ["settings", "email-provider-status"],
    queryFn: () => apiFetch<ProviderStatus>("/emails/provider-status"),
  });

  const reconcile = useMutation({
    mutationFn: () => apiFetch<ReconciliationSummary>("/emails/reconcile", { method: "POST" }),
    onSuccess: (summary) => {
      toast({
        title: "Reconciliación completa",
        description: `${summary.sentItemsScanned} mensajes reales revisados en Sent Items -- ${summary.confirmedThisRun} confirmados, ${summary.untrackedAlertsCreated} alertas nuevas de envío no rastreado, ${summary.bounced} rebotados.`,
        variant: summary.untrackedAlertsCreated > 0 ? "error" : "success",
      });
      queryClient.invalidateQueries({ queryKey: ["settings", "email-reconciliation-alerts"] });
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => toast({ title: "No se pudo reconciliar con Outlook", description: err instanceof ApiError ? err.message : undefined, variant: "error" }),
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => apiFetch(`/emails/reconciliation-alerts/${id}/acknowledge`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Alerta reconocida", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["settings", "email-reconciliation-alerts"] });
    },
    onError: (err) => toast({ title: "No se pudo reconocer la alerta", description: err instanceof ApiError ? err.message : undefined, variant: "error" }),
  });

  const ps = providerStatus.data;

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Trazabilidad de correo saliente</CardTitle>
        <Button size="sm" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
          {reconcile.isPending ? "Reconciliando…" : "Reconciliar con Outlook"}
        </Button>
      </CardHeader>

      <div className="space-y-4 p-4 pt-0 text-sm">
        {ps?.deliverability.degraded && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            <p className="font-medium">Entregabilidad degradada (verificado {ps.deliverability.lastVerifiedAt})</p>
            <p>{ps.deliverability.detail}</p>
          </div>
        )}

        {ps && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">Microsoft Graph</p>
              <Badge variant={ps.microsoftGraph.healthy ? "success" : "danger"}>{ps.microsoftGraph.healthy ? "Conectado" : "Sin conexión"}</Badge>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">People Data Labs</p>
              <div className="mt-1">{circuitBadge(ps.peopleDataLabs.circuitStatus)}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {ps.peopleDataLabs.creditsUsedThisMonth}/{ps.peopleDataLabs.monthlyCreditBudget} créditos este mes
              </p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">Hunter.io</p>
              <div className="mt-1">{circuitBadge(ps.hunter.circuitStatus)}</div>
              <p className="mt-1 text-xs text-muted-foreground">{ps.hunter.domainsQueriedOrCachedThisMonth} dominios este mes</p>
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 font-medium">Alertas de envío no rastreado</p>
          {alerts.error ? (
            <p className="text-xs text-muted-foreground">No se pudo cargar esta sección.</p>
          ) : alerts.data && alerts.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Buzón</TableHead>
                  <TableHead>Destinatarios</TableHead>
                  <TableHead>Asunto</TableHead>
                  <TableHead>Enviado (real)</TableHead>
                  <TableHead>Detectado</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.data.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.mailbox}</TableCell>
                    <TableCell className="text-muted-foreground">{a.toRecipients.join(", ") || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{a.subject ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{a.sentDateTime ? new Date(a.sentDateTime).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(a.discoveredAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate(a.id)}>
                        Reconocer
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-xs text-muted-foreground">Sin envíos reales sin rastrear detectados.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
