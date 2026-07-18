import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BillingReadinessResultDto, CompanyListItem, CreateInvoiceInput, InvoiceListItem, Paginated } from "@ai-staffing-os/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { LoadingTable } from "@/components/shared/LoadingTable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

const STATUS_FILTERS = ["DRAFT", "SENT", "PAID", "OVERDUE", "VOID"];

/**
 * F9.8: consulta puntual de Billing Readiness antes de generar un
 * Invoice real -- muestra ingreso/costo/margen estimados y bloqueadores
 * reales (ej. Contract EXPIRED), siempre contra el backend (nunca
 * calculado en el frontend). Solo lectura -- nunca emite una factura.
 */
function BillingReadinessPanel() {
  const { toast } = useToast();
  const { data: companies } = useQuery({
    queryKey: ["companies", "for-billing-readiness"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });
  const [companyId, setCompanyId] = useState("");
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitted, setSubmitted] = useState<{ companyId: string; periodStart: string; periodEnd: string } | null>(null);

  const query = useQuery({
    queryKey: ["billing-readiness", submitted],
    queryFn: () =>
      apiFetch<BillingReadinessResultDto>(
        `/billing/readiness?companyId=${submitted!.companyId}&periodStart=${submitted!.periodStart}&periodEnd=${submitted!.periodEnd}`,
      ),
    enabled: !!submitted,
    retry: false,
  });

  return (
    <Card className="mb-4 space-y-3 p-4">
      <p className="text-sm font-medium">Billing Readiness</p>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!companyId) {
            toast({ title: "Selecciona una empresa", variant: "error" });
            return;
          }
          setSubmitted({ companyId, periodStart, periodEnd });
        }}
      >
        <div>
          <Label htmlFor="readinessCompanyId">Empresa</Label>
          <Select id="readinessCompanyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">Selecciona…</option>
            {companies?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="readinessPeriodStart">Desde</Label>
          <Input id="readinessPeriodStart" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="readinessPeriodEnd">Hasta</Label>
          <Input id="readinessPeriodEnd" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button type="submit" size="sm" className="w-full" disabled={query.isFetching}>
            {query.isFetching ? "Evaluando…" : "Evaluar"}
          </Button>
        </div>
      </form>

      {query.isError && (
        <p role="alert" className="text-sm text-destructive">
          {query.error instanceof ApiError ? query.error.message : "No se pudo evaluar readiness."}
        </p>
      )}

      {query.data && (
        <div className="space-y-2 border-t border-border pt-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={statusVariant(query.data.status)}>{formatStatusLabel(query.data.status)}</Badge>
            <span>Ingreso estimado: <strong>${query.data.estimatedRevenue}</strong></span>
            <span>Costo estimado: <strong>${query.data.estimatedLaborCost}</strong></span>
            <span>Utilidad bruta: <strong>${query.data.estimatedGrossProfit}</strong></span>
            <span>Margen: <strong>{query.data.estimatedMarginPercent}%</strong></span>
          </div>
          {query.data.blockers.length > 0 && (
            <p className="text-destructive">
              <span className="font-medium">Bloqueadores: </span>
              {query.data.blockers.join(" · ")}
            </p>
          )}
          {query.data.reviewNotes.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              <span className="font-medium">Notas: </span>
              {query.data.reviewNotes.join(" · ")}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function CreateInvoiceForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: companies } = useQuery({
    queryKey: ["companies", "for-invoice-form"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
  });

  const [form, setForm] = useState<CreateInvoiceInput>(() => ({
    companyId: "",
    periodStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
  }));

  const createMutation = useMutation({
    mutationFn: (input: CreateInvoiceInput) => apiFetch<{ id: string }>("/invoices", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (invoice) => {
      toast({ title: "Invoice generado (DRAFT)", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      onCreated(invoice.id);
    },
    onError: (err) => toast({ title: "No se pudo generar el invoice", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <p className="text-xs text-muted-foreground">
        Agrega las horas de nómina ya aprobadas (PayrollRun APPROVED o posterior) y no facturadas todavía, para la
        empresa y período elegidos. Una línea por trabajador/assignment.
      </p>
      <div>
        <Label htmlFor="companyId">Empresa *</Label>
        <Select id="companyId" required value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
          <option value="">Selecciona…</option>
          {companies?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="periodStart">Desde *</Label>
          <Input
            id="periodStart"
            type="date"
            required
            value={form.periodStart.slice(0, 10)}
            onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="periodEnd">Hasta *</Label>
          <Input
            id="periodEnd"
            type="date"
            required
            value={form.periodEnd.slice(0, 10)}
            onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
          />
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !form.companyId}>
        {createMutation.isPending ? "Generando…" : "Generar Invoice"}
      </Button>
    </form>
  );
}

export default function Invoices() {
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const canCreate = currentUser?.permissions.includes("invoices.create") ?? false;

  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  if (status) params.set("status", status);
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery({
    queryKey: ["invoices", cursor, status, search],
    queryFn: () => apiFetch<Paginated<InvoiceListItem>>(`/invoices?${params.toString()}`),
  });

  function resetAndFilter(fn: () => void) {
    fn();
    setCursorStack([undefined]);
  }

  return (
    <div>
      <PageHeader title="Invoices" description="Facturación a clientes generada desde nómina ya aprobada" />

      <BillingReadinessPanel />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="w-44">
          <Label htmlFor="statusFilter">Estado</Label>
          <Select id="statusFilter" value={status} onChange={(e) => resetAndFilter(() => setStatus(e.target.value))}>
            <option value="">Todos</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <Label htmlFor="search">Buscar número</Label>
          <Input id="search" placeholder="INV-2026-00001" value={search} onChange={(e) => resetAndFilter(() => setSearch(e.target.value))} />
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Generate Invoice
          </Button>
        )}
      </Card>

      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Período</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Pagado</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Vencimiento</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((invoice) => (
                <TableRow key={invoice.id} className="cursor-pointer" onClick={() => navigate(`/invoices/${invoice.id}`)}>
                  <TableCell className="font-medium">{invoice.number}</TableCell>
                  <TableCell className="text-muted-foreground">{invoice.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(invoice.periodStart).toLocaleDateString()} – {new Date(invoice.periodEnd).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-medium">${invoice.total}</TableCell>
                  <TableCell className="text-emerald-600 dark:text-emerald-400">${invoice.paidTotal}</TableCell>
                  <TableCell className={Number(invoice.balance) > 0 ? "font-medium" : "text-muted-foreground"}>
                    ${invoice.balance}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(invoice.status)}>{formatStatusLabel(invoice.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Sin Invoices todavía — genera el primero con "Generate Invoice".
          </p>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="Generate Invoice">
        <CreateInvoiceForm
          onCreated={(id) => {
            setCreateOpen(false);
            navigate(`/invoices/${id}`);
          }}
        />
      </Drawer>
    </div>
  );
}
