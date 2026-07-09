import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyListItem,
  CreateFollowUpInput,
  FollowUpListItem,
  LeadListItem,
  Paginated,
} from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { Plus } from "lucide-react";

function NewFollowUpForm({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [entityType, setEntityType] = useState<"company" | "lead">("company");
  const [entityId, setEntityId] = useState("");
  const [type, setType] = useState<CreateFollowUpInput["type"]>("CALL");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<CreateFollowUpInput["priority"]>("MEDIUM");
  const [notes, setNotes] = useState("");

  const { data: companies } = useQuery({
    queryKey: ["companies", "all-for-select"],
    queryFn: () => apiFetch<Paginated<CompanyListItem>>("/companies?limit=100"),
    enabled: entityType === "company",
  });
  const { data: leads } = useQuery({
    queryKey: ["leads", "all-for-select"],
    queryFn: () => apiFetch<Paginated<LeadListItem>>("/leads?limit=100"),
    enabled: entityType === "lead",
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateFollowUpInput) =>
      apiFetch("/follow-ups", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Seguimiento creado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
      onCreated();
    },
    onError: (err) => toast({ title: "No se pudo crear el seguimiento", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate({
          entityType,
          entityId,
          type,
          dueDate: new Date(dueDate).toISOString(),
          priority,
          notes: notes || undefined,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Relacionado con</Label>
          <Select value={entityType} onChange={(e) => { setEntityType(e.target.value as "company" | "lead"); setEntityId(""); }}>
            <option value="company">Empresa</option>
            <option value="lead">Lead</option>
          </Select>
        </div>
        <div>
          <Label>{entityType === "company" ? "Empresa" : "Lead"}</Label>
          <Select required value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Selecciona…</option>
            {entityType === "company"
              ? companies?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))
              : leads?.items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.companyName ?? `Lead sin empresa (${l.city ?? "?"})`}
                  </option>
                ))}
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Tipo</Label>
          <Select value={type} onChange={(e) => setType(e.target.value as CreateFollowUpInput["type"])}>
            {["CALL", "EMAIL", "LINKEDIN", "MEETING"].map((t) => (
              <option key={t} value={t}>
                {formatStatusLabel(t)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Prioridad</Label>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as CreateFollowUpInput["priority"])}>
            {["LOW", "MEDIUM", "HIGH"].map((p) => (
              <option key={p} value={p}>
                {formatStatusLabel(p)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label>Fecha</Label>
        <Input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <div>
        <Label>Notas</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Button type="submit" className="w-full" disabled={createMutation.isPending || !entityId}>
        {createMutation.isPending ? "Creando…" : "Crear seguimiento"}
      </Button>
    </form>
  );
}

function FollowUpRow({ item }: { item: FollowUpListItem }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateMutation = useMutation({
    mutationFn: (body: { status?: string; dueDate?: string }) =>
      apiFetch(`/follow-ups/${item.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: "Seguimiento actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar", description: String(err), variant: "error" }),
  });

  function snooze() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    updateMutation.mutate({ dueDate: tomorrow.toISOString() });
  }

  return (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={() => {
          if (item.entityType === "company") navigate(`/companies/${item.entityId}`);
          if (item.entityType === "lead") navigate(`/leads/${item.entityId}`);
        }}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.entityLabel}</span>
          <Badge variant="neutral">{formatStatusLabel(item.type)}</Badge>
          <Badge variant={statusVariant(item.priority)}>{formatStatusLabel(item.priority)}</Badge>
        </div>
        {item.notes && <p className="mt-0.5 text-sm text-muted-foreground">{item.notes}</p>}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.assignedToLabel ?? "Sin asignar"} · {new Date(item.dueDate).toLocaleDateString()}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={snooze} disabled={updateMutation.isPending}>
          Posponer
        </Button>
        <Button size="sm" onClick={() => updateMutation.mutate({ status: "DONE" })} disabled={updateMutation.isPending}>
          Completar
        </Button>
      </div>
    </div>
  );
}

export default function FollowUps() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["follow-ups"],
    queryFn: () => apiFetch<Paginated<FollowUpListItem>>("/follow-ups?status=PENDING&limit=100"),
  });

  const { overdue, today, upcoming } = useMemo(() => {
    const items = data?.items ?? [];
    const todayStr = new Date().toDateString();
    return {
      overdue: items.filter((i) => i.overdue),
      today: items.filter((i) => !i.overdue && new Date(i.dueDate).toDateString() === todayStr),
      upcoming: items.filter((i) => !i.overdue && new Date(i.dueDate).toDateString() !== todayStr),
    };
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Follow-ups"
        description="Seguimientos comerciales pendientes"
        action={
          <Button onClick={() => setDrawerOpen(true)}>
            <Plus className="h-4 w-4" />
            New Follow-up
          </Button>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-red-600 dark:text-red-400">Vencidos ({overdue.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {overdue.length ? (
                overdue.map((i) => <FollowUpRow key={i.id} item={i} />)
              ) : (
                <p className="text-sm text-muted-foreground">Nada vencido.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Hoy ({today.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {today.length ? (
                today.map((i) => <FollowUpRow key={i.id} item={i} />)
              ) : (
                <p className="text-sm text-muted-foreground">Nada para hoy.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Próximos ({upcoming.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {upcoming.length ? (
                upcoming.map((i) => <FollowUpRow key={i.id} item={i} />)
              ) : (
                <p className="text-sm text-muted-foreground">Nada próximo.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="New Follow-up">
        <NewFollowUpForm onCreated={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  );
}
