import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PayrollRunDetail } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { getAuthToken } from "@/lib/auth-token";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1`;

export default function PayrollRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [isExporting, setIsExporting] = useState(false);

  const canApprove = currentUser?.permissions.includes("payroll.approve") ?? false;
  const canSubmit = currentUser?.permissions.includes("payrollRuns.update") ?? false;

  const { data: run, isLoading } = useQuery({
    queryKey: ["payroll-run", id],
    queryFn: () => apiFetch<PayrollRunDetail>(`/payroll/runs/${id}`),
    enabled: !!id,
  });

  const transitionMutation = useMutation({
    mutationFn: (action: "submit" | "approve" | "mark-paid") =>
      apiFetch(`/payroll/runs/${id}/${action}`, { method: "POST" }),
    onSuccess: (_data, action) => {
      toast({ title: `Payroll run actualizado (${action})`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["payroll-run", id] });
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar el run", description: String(err), variant: "error" }),
  });

  async function handleExport() {
    setIsExporting(true);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/payroll/runs/${id}/export`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="(.+)"/);
      const filename = filenameMatch?.[1] ?? "payroll-run.csv";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast({ title: "CSV exportado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["payroll-run", id] });
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
    } catch (err) {
      toast({ title: "No se pudo exportar", description: String(err), variant: "error" });
    } finally {
      setIsExporting(false);
    }
  }

  if (isLoading || !run) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <Link to="/payroll" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Payroll
      </Link>

      <PageHeader
        title={`${new Date(run.periodStart).toLocaleDateString()} – ${new Date(run.periodEnd).toLocaleDateString()}`}
        description={`${run.itemCount} worker(s) · Creado por ${run.createdByName ?? "—"}`}
        action={<Badge variant={statusVariant(run.status)}>{formatStatusLabel(run.status)}</Badge>}
      />

      <Card className="mb-4 p-3">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Acciones</p>
        <div className="flex flex-wrap gap-2">
          {run.status === "DRAFT" && canSubmit && (
            <Button size="sm" variant="outline" disabled={transitionMutation.isPending} onClick={() => transitionMutation.mutate("submit")}>
              Enviar a aprobación
            </Button>
          )}
          {run.status === "PENDING_APPROVAL" && canApprove && (
            <Button size="sm" variant="outline" disabled={transitionMutation.isPending} onClick={() => transitionMutation.mutate("approve")}>
              Aprobar
            </Button>
          )}
          {run.status === "APPROVED" && canApprove && (
            <Button size="sm" variant="outline" disabled={transitionMutation.isPending} onClick={() => transitionMutation.mutate("mark-paid")}>
              Marcar como pagado
            </Button>
          )}
          {run.status === "PAID" && canApprove && (
            <Button size="sm" variant="outline" disabled={isExporting} onClick={handleExport}>
              {isExporting ? "Exportando…" : "Exportar CSV"}
            </Button>
          )}
          {run.status === "EXPORTED" && <p className="text-sm text-muted-foreground">Este run ya fue exportado.</p>}
        </div>
        {run.status === "PENDING_APPROVAL" && run.createdByName && (
          <p className="mt-2 text-xs text-muted-foreground">
            Separación de funciones: quien creó este run no puede aprobarlo.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Gross</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">${run.totalGross}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bill</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">${run.totalBill}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Margen</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
            ${run.totalMargin}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Detalle por Worker</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Job Order</TableHead>
                <TableHead>Reg / OT hrs</TableHead>
                <TableHead>Regular / OT pay</TableHead>
                <TableHead>Per diem / Bono</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Margen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.workerName}</TableCell>
                  <TableCell className="text-muted-foreground">{item.jobOrderTitle}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.regularHours} / {item.otHours}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    ${item.regularPay} / ${item.otPay}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    ${item.perDiem} / ${item.bonus}
                  </TableCell>
                  <TableCell className="font-medium">${item.grossPay}</TableCell>
                  <TableCell className="text-muted-foreground">${item.billAmount}</TableCell>
                  <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">${item.margin}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
