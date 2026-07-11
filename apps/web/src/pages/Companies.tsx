import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyDetail,
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
import { Card } from "@/components/ui/card";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { normalizeImportRow, parseSpreadsheetFile } from "@/lib/importCompanies";
import { timeAgo } from "@/lib/agentTaskStats";
import { CompanyOriginBadge } from "@/components/shared/CompanyOriginBadge";
import { Bot, Briefcase, Calendar, Plus, Sparkles, Upload } from "lucide-react";

const COMPANY_SIZES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"];

const LOGO_PALETTE = [
  "bg-primary/15 text-primary",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-pink-500/15 text-pink-600 dark:text-pink-400",
];

function logoTone(name: string): string {
  const sum = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return LOGO_PALETTE[sum % LOGO_PALETTE.length]!;
}

function hiringProbability(score: number | null): { label: string; variant: NonNullable<BadgeProps["variant"]> } {
  if (score == null) return { label: "Sin score", variant: "neutral" };
  if (score >= 70) return { label: "Alta", variant: "success" };
  if (score >= 40) return { label: "Media", variant: "warning" };
  return { label: "Baja", variant: "danger" };
}

function priorityLevel(company: CompanyListItem): { label: string; variant: NonNullable<BadgeProps["variant"]> } {
  if (company.nextFollowUp && new Date(company.nextFollowUp.dueDate) < new Date()) {
    return { label: "Urgente", variant: "danger" };
  }
  if (company.openOpportunityCount > 0) {
    return { label: "Prioridad media", variant: "warning" };
  }
  return { label: "Prioridad baja", variant: "neutral" };
}

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

function CompanyCard({
  company,
  detail,
  onClick,
}: {
  company: CompanyListItem;
  detail: CompanyDetail | undefined;
  onClick: () => void;
}) {
  const probability = hiringProbability(company.commercialScore);
  const priority = priorityLevel(company);
  const isAiTouched =
    !!detail &&
    (detail.opportunities.some((o) => o.createdByAgentTaskId) ||
      detail.upcomingFollowUps.some((f) => f.createdByAgentTaskId));

  return (
    <Card className="card-hover flex cursor-pointer flex-col gap-3 p-4" onClick={onClick}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold ${logoTone(company.name)}`}
          >
            {company.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium" title={company.name}>
              {company.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">{company.industryName}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>
          <CompanyOriginBadge origin={company.origin} title={company.sourceUrl ?? undefined} />
          {isAiTouched && (
            <Badge variant="primary" title="Con actividad del Prospecting Agent">
              <Bot className="mr-0.5 h-3 w-3" />
              AI
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-3 py-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Score IA</p>
          <p className="text-2xl font-semibold tabular-nums tracking-tight">
            {company.commercialScore != null ? company.commercialScore : "—"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={probability.variant}>Contratación: {probability.label}</Badge>
          <Badge variant={priority.variant}>{priority.label}</Badge>
        </div>
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="line-clamp-2">
            {detail
              ? (detail.commercialScoreReason ?? "Sin señales registradas todavía.")
              : "Cargando señales…"}
          </span>
        </p>
        <p className="flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5 shrink-0" />
          {company.nextFollowUp
            ? `Próxima acción: ${formatStatusLabel(company.nextFollowUp.type)} · ${new Date(company.nextFollowUp.dueDate).toLocaleDateString()}`
            : "Sin próxima acción sugerida"}
        </p>
        <p className="flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5 shrink-0" />
          {company.openOpportunityCount} oportunidad(es) abierta(s)
        </p>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
        <span>{company.city && company.state ? `${company.city}, ${company.state}` : "Ubicación —"}</span>
        <span>{company.lastActivityAt ? `Actividad ${timeAgo(company.lastActivityAt)}` : "Sin actividad"}</span>
      </div>
    </Card>
  );
}

function CompanyCardGrid({ companies, onOpen }: { companies: CompanyListItem[]; onOpen: (id: string) => void }) {
  const detailQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: ["company", c.id],
      queryFn: () => apiFetch<CompanyDetail>(`/companies/${c.id}`),
    })),
  });

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {companies.map((company, i) => (
        <CompanyCard
          key={company.id}
          company={company}
          detail={detailQueries[i]?.data}
          onClick={() => onOpen(company.id)}
        />
      ))}
    </div>
  );
}

export default function Companies() {
  const navigate = useNavigate();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Datos demo/real: por defecto solo se ven datos reales en esta vista
  // comercial (excludeDemo=true) — un humano puede destildar para ver
  // también las empresas de demo (origin=DEMO_SEED), nunca al revés.
  const [excludeDemo, setExcludeDemo] = useState(true);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading } = useQuery({
    queryKey: ["companies", cursor, excludeDemo],
    queryFn: () =>
      apiFetch<Paginated<CompanyListItem>>(
        `/companies?limit=20${cursor ? `&cursor=${cursor}` : ""}${excludeDemo ? "&excludeDemo=true" : ""}`,
      ),
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Clientes y prospectos de la agencia"
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                checked={excludeDemo}
                onChange={(e) => {
                  setExcludeDemo(e.target.checked);
                  setCursorStack([undefined]);
                }}
              />
              Solo datos reales
            </label>
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

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-52" />
          ))}
        </div>
      ) : data?.items.length ? (
        <CompanyCardGrid companies={data.items} onOpen={(id) => navigate(`/companies/${id}`)} />
      ) : (
        <Card className="p-6 text-center text-sm text-muted-foreground">Sin empresas todavía.</Card>
      )}

      <Card className="mt-4">
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
