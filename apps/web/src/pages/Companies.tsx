import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyListItem,
  CreateCompanyInput,
  ImportCompaniesResult,
  ImportCompanyRow,
  IndustryListItem,
  Paginated,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
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
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { normalizeImportRow, parseSpreadsheetFile } from "@/lib/importCompanies";
import { Plus, Upload } from "lucide-react";

const COMPANY_SIZES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"];

function NewCompanyForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: industries } = useQuery({
    queryKey: ["industries"],
    queryFn: () => apiFetch<IndustryListItem[]>("/industries"),
  });

  const [form, setForm] = useState<CreateCompanyInput>({ name: "", industryId: "" });

  const createMutation = useMutation({
    mutationFn: (input: CreateCompanyInput) => apiFetch<{ id: string }>("/companies", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Empresa creada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      onCreated();
    },
    onError: (err) => {
      toast({ title: "No se pudo crear la empresa", description: String(err), variant: "error" });
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate(form);
      }}
    >
      <div>
        <Label htmlFor="name">Nombre</Label>
        <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="industryId">Industria</Label>
        <Select
          id="industryId"
          required
          value={form.industryId}
          onChange={(e) => setForm({ ...form, industryId: e.target.value })}
        >
          <option value="">Selecciona una industria…</option>
          {industries?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="city">Ciudad</Label>
          <Input id="city" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="state">Estado</Label>
          <Input id="state" value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="estimatedSize">Tamaño estimado</Label>
          <Select
            id="estimatedSize"
            value={form.estimatedSize ?? ""}
            onChange={(e) => setForm({ ...form, estimatedSize: (e.target.value || undefined) as never })}
          >
            <option value="">—</option>
            {COMPANY_SIZES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="commercialScore">Score comercial</Label>
          <Input
            id="commercialScore"
            type="number"
            min={0}
            max={100}
            value={form.commercialScore ?? ""}
            onChange={(e) => setForm({ ...form, commercialScore: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="notes">Notas</Label>
        <Textarea id="notes" value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Creando…" : "Crear empresa"}
      </Button>
    </form>
  );
}

function ImportCompaniesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportCompanyRow[]>([]);
  const [invalidCount, setInvalidCount] = useState(0);

  const importMutation = useMutation({
    mutationFn: (rows: ImportCompanyRow[]) =>
      apiFetch<ImportCompaniesResult>("/prospecting/import", { method: "POST", body: JSON.stringify({ rows }) }),
    onSuccess: (result) => {
      toast({
        title: `${result.importedCount} empresa(s) importada(s)`,
        description: result.skipped.length ? `${result.skipped.length} fila(s) omitida(s) — ver detalle` : undefined,
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setRows([]);
      setFileName("");
      onClose();
    },
    onError: (err) => toast({ title: "No se pudo importar", description: String(err), variant: "error" }),
  });

  async function handleFile(file: File) {
    setFileName(file.name);
    try {
      const raw = await parseSpreadsheetFile(file);
      const normalized = raw.map(normalizeImportRow);
      const valid = normalized.filter((r): r is ImportCompanyRow => r !== null);
      setInvalidCount(normalized.length - valid.length);
      setRows(valid);
    } catch (err) {
      toast({ title: "No se pudo leer el archivo", description: String(err), variant: "error" });
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Importar empresas">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          CSV o Excel (Google Sheets: exportar como CSV primero) con columnas <code>name</code>,{" "}
          <code>industryName</code> (debe coincidir con una industria existente — no se inventa una nueva), y
          opcionalmente <code>city</code>, <code>state</code>, <code>website</code>, <code>estimatedSize</code>,{" "}
          <code>contactFirstName</code>, <code>contactLastName</code>, <code>contactEmail</code>,{" "}
          <code>contactTitle</code>.
        </p>
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
        />
        {fileName && (
          <p className="text-xs text-muted-foreground">
            {fileName}: {rows.length} fila(s) válida(s)
            {invalidCount > 0 ? `, ${invalidCount} sin nombre/industria (omitidas)` : ""}
          </p>
        )}
        {rows.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="p-2 text-left font-medium">Empresa</th>
                  <th className="p-2 text-left font-medium">Industria</th>
                  <th className="p-2 text-left font-medium">Contacto</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 25).map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="p-2">{r.name}</td>
                    <td className="p-2 text-muted-foreground">{r.industryName}</td>
                    <td className="p-2 text-muted-foreground">
                      {r.contactFirstName ? `${r.contactFirstName} ${r.contactLastName ?? ""}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Button
          className="w-full"
          disabled={rows.length === 0 || importMutation.isPending}
          onClick={() => importMutation.mutate(rows)}
        >
          {importMutation.isPending ? "Importando…" : `Importar ${rows.length || ""} empresa(s)`}
        </Button>
      </div>
    </Drawer>
  );
}

export default function Companies() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["companies", cursor],
    queryFn: () =>
      apiFetch<Paginated<CompanyListItem>>(`/companies?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Clientes y prospectos de la agencia"
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              Importar empresas
            </Button>
            <Button onClick={() => setDrawerOpen(true)}>
              <Plus className="h-4 w-4" />
              New Company
            </Button>
          </div>
        }
      />
      <Card>
        {isLoading ? (
          <LoadingTable />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Industria</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead>Tamaño</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Oportunidades abiertas</TableHead>
                <TableHead>Próxima acción</TableHead>
                <TableHead>Último contacto</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.map((company) => (
                <TableRow
                  key={company.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/companies/${company.id}`)}
                >
                  <TableCell className="font-medium">{company.name}</TableCell>
                  <TableCell className="text-muted-foreground">{company.industryName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.city && company.state ? `${company.city}, ${company.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.estimatedSize ? formatStatusLabel(company.estimatedSize) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.commercialScore != null ? company.commercialScore : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{company.openOpportunityCount}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.nextFollowUp
                      ? `${formatStatusLabel(company.nextFollowUp.type)} · ${new Date(company.nextFollowUp.dueDate).toLocaleDateString()}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.lastActivityAt ? new Date(company.lastActivityAt).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={!!data?.nextCursor}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </Card>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Company">
        <NewCompanyForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>

      <ImportCompaniesDrawer open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
