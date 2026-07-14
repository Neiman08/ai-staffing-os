import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatePaymentInput, InvoiceDetail } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

function RegisterPaymentForm({ invoice, onDone }: { invoice: InvoiceDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreatePaymentInput>({ amount: Number(invoice.balance) });

  const mutation = useMutation({
    mutationFn: (input: CreatePaymentInput) =>
      apiFetch(`/invoices/${invoice.id}/payments`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Pago registrado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo registrar el pago", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <p className="text-xs text-muted-foreground">Balance pendiente: ${invoice.balance}</p>
      <div>
        <Label htmlFor="amount">Monto *</Label>
        <Input
          id="amount"
          type="number"
          min={0.01}
          max={Number(invoice.balance)}
          step="0.01"
          required
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label htmlFor="method">Método</Label>
        <Input id="method" value={form.method ?? ""} onChange={(e) => setForm({ ...form, method: e.target.value || undefined })} />
      </div>
      <div>
        <Label htmlFor="reference">Referencia</Label>
        <Input id="reference" value={form.reference ?? ""} onChange={(e) => setForm({ ...form, reference: e.target.value || undefined })} />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending || form.amount <= 0}>
        {mutation.isPending ? "Registrando…" : "Registrar pago"}
      </Button>
    </form>
  );
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [voidConfirmOpen, setVoidConfirmOpen] = useState(false);

  const canSend = currentUser?.permissions.includes("invoices.send") ?? false;
  const canUpdate = currentUser?.permissions.includes("invoices.update") ?? false;

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => apiFetch<InvoiceDetail>(`/invoices/${id}`),
    enabled: !!id,
  });

  const sendMutation = useMutation({
    mutationFn: () => apiFetch(`/invoices/${id}/send`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Invoice enviado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["invoice", id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (err) => toast({ title: "No se pudo enviar el invoice", description: String(err), variant: "error" }),
  });

  const voidMutation = useMutation({
    mutationFn: () => apiFetch(`/invoices/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: "VOID" }) }),
    onSuccess: () => {
      toast({ title: "Invoice anulado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["invoice", id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setVoidConfirmOpen(false);
    },
    onError: (err) => toast({ title: "No se pudo anular el invoice", description: String(err), variant: "error" }),
  });

  if (isLoading || !invoice) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const canVoid = canUpdate && (invoice.status === "DRAFT" || invoice.status === "SENT" || invoice.status === "OVERDUE");
  const canPay = canUpdate && (invoice.status === "SENT" || invoice.status === "OVERDUE");

  return (
    <div>
      <Link to="/invoices" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Invoices
      </Link>

      <PageHeader
        title={invoice.number}
        description={`${invoice.companyName} · ${new Date(invoice.periodStart).toLocaleDateString()} – ${new Date(invoice.periodEnd).toLocaleDateString()}`}
        action={<Badge variant={statusVariant(invoice.status)}>{formatStatusLabel(invoice.status)}</Badge>}
      />

      <Card className="mb-4 p-3">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Acciones</p>
        <div className="flex flex-wrap gap-2">
          {invoice.status === "DRAFT" && canSend && (
            <Button size="sm" variant="outline" disabled={sendMutation.isPending} onClick={() => sendMutation.mutate()}>
              Enviar a cliente
            </Button>
          )}
          {canPay && (
            <Button size="sm" variant="outline" onClick={() => setPaymentOpen(true)}>
              Registrar pago
            </Button>
          )}
          {canVoid && (
            <Button size="sm" variant="outline" onClick={() => setVoidConfirmOpen(true)}>
              Anular
            </Button>
          )}
          {(invoice.status === "PAID" || invoice.status === "VOID") && (
            <p className="text-sm text-muted-foreground">
              {invoice.status === "PAID" ? "Este invoice ya está pagado en su totalidad." : "Este invoice fue anulado."}
            </p>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Subtotal</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">${invoice.subtotal}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">${invoice.total}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pagado</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">${invoice.paidTotal}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Balance</CardTitle>
          </CardHeader>
          <CardContent className={`text-2xl font-semibold ${Number(invoice.balance) > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
            ${invoice.balance}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Líneas</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Descripción</TableHead>
                <TableHead>Horas</TableHead>
                <TableHead>Tarifa</TableHead>
                <TableHead>Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-medium">{line.description}</TableCell>
                  <TableCell className="text-muted-foreground">{line.quantity}</TableCell>
                  <TableCell className="text-muted-foreground">${line.rate}</TableCell>
                  <TableCell className="font-medium">${line.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Pagos</CardTitle>
        </CardHeader>
        <CardContent>
          {invoice.payments.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Sin pagos registrados todavía.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Monto</TableHead>
                  <TableHead>Método</TableHead>
                  <TableHead>Referencia</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="text-muted-foreground">{new Date(payment.paidAt).toLocaleDateString()}</TableCell>
                    <TableCell className="font-medium text-emerald-600 dark:text-emerald-400">${payment.amount}</TableCell>
                    <TableCell className="text-muted-foreground">{payment.method ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{payment.reference ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={paymentOpen} onClose={() => setPaymentOpen(false)} title="Registrar pago">
        <RegisterPaymentForm invoice={invoice} onDone={() => setPaymentOpen(false)} />
      </Drawer>

      {voidConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm p-4">
            <p className="text-sm font-medium">¿Anular este invoice?</p>
            <p className="mt-2 text-xs text-muted-foreground">
              El registro no se elimina — queda guardado con estado Void, un estado terminal sin reapertura.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setVoidConfirmOpen(false)}>
                Volver
              </Button>
              <Button size="sm" disabled={voidMutation.isPending} onClick={() => voidMutation.mutate()}>
                {voidMutation.isPending ? "Anulando…" : "Confirmar"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
