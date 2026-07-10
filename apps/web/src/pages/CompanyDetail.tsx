import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityItem, CompanyDetail, ContactInput, UpdateCompanyInput } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Timeline } from "@/components/shared/Timeline";
import { AgentTaskAction } from "@/components/shared/AgentTaskAction";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { CompanyOriginBadge } from "@/components/shared/CompanyOriginBadge";

const VERIFICATION_LABELS: Record<string, string> = {
  UNVERIFIED: "Sin verificar",
  CONFIRMED: "Confirmado",
  INFERRED: "Inferido",
};

const EXTERNAL_ORIGINS = new Set(["EXTERNAL_DISCOVERY", "API_PROVIDER"]);

const COMPANY_STATUSES = ["LEAD", "PROSPECT", "CLIENT", "INACTIVE"];
const COMPANY_SIZES = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"];

function EditCompanyForm({ company, onDone }: { company: CompanyDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateCompanyInput>({
    name: company.name,
    status: company.status as UpdateCompanyInput["status"],
    website: company.website ?? "",
    phone: company.phone ?? "",
    city: company.city ?? "",
    state: company.state ?? "",
    estimatedSize: company.estimatedSize ?? undefined,
    commercialScore: company.commercialScore ?? undefined,
    notes: company.notes ?? "",
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateCompanyInput) =>
      apiFetch(`/companies/${company.id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Empresa actualizada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo actualizar la empresa", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <div>
        <Label>Nombre</Label>
        <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div>
        <Label>Estado comercial</Label>
        <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as UpdateCompanyInput["status"] })}>
          {COMPANY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatStatusLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Ciudad</Label>
          <Input value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label>Estado</Label>
          <Input value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Sitio web</Label>
          <Input value={form.website ?? ""} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        </div>
        <div>
          <Label>Teléfono</Label>
          <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Tamaño estimado</Label>
          <Select
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
          <Label>Score comercial</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={form.commercialScore ?? ""}
            onChange={(e) => setForm({ ...form, commercialScore: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </div>
      <div>
        <Label>Notas</Label>
        <Textarea value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}

const TABS = ["overview", "contacts", "opportunities", "followups", "activity"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Resumen",
  contacts: "Contactos",
  opportunities: "Oportunidades",
  followups: "Seguimientos",
  activity: "Actividad",
};

const DECISION_ROLES = ["OWNER", "HR", "OPERATIONS_MANAGER", "PROJECT_MANAGER", "PLANT_MANAGER", "RECRUITER", "OTHER"];

function AddContactForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ContactInput>({ firstName: "", lastName: "" });

  const mutation = useMutation({
    mutationFn: (input: ContactInput) =>
      apiFetch(`/companies/${companyId}/contacts`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Contacto agregado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo agregar el contacto", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="grid grid-cols-2 gap-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <div>
        <Label>Nombre</Label>
        <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
      </div>
      <div>
        <Label>Apellido</Label>
        <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </div>
      <div>
        <Label>Cargo</Label>
        <Input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div>
        <Label>Rol de decisión</Label>
        <Select
          value={form.decisionRole ?? ""}
          onChange={(e) => setForm({ ...form, decisionRole: (e.target.value || undefined) as never })}
        >
          <option value="">—</option>
          {DECISION_ROLES.map((r) => (
            <option key={r} value={r}>
              {formatStatusLabel(r)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Email</Label>
        <Input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div>
        <Label>Teléfono</Label>
        <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="col-span-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? "Agregando…" : "Agregar contacto"}
        </Button>
      </div>
    </form>
  );
}

function ContactRow({ contact, companyId }: { contact: CompanyDetail["contacts"][number]; companyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ContactInput>({
    firstName: contact.firstName,
    lastName: contact.lastName,
    title: contact.title ?? "",
    decisionRole: contact.decisionRole ?? undefined,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
  });

  const mutation = useMutation({
    mutationFn: (input: ContactInput) =>
      apiFetch(`/contacts/${contact.id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Contacto actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      setEditing(false);
    },
    onError: (err) => toast({ title: "No se pudo actualizar el contacto", description: String(err), variant: "error" }),
  });

  if (editing) {
    return (
      <form
        className="grid grid-cols-2 gap-3 rounded-md border border-primary/40 bg-primary/5 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(form);
        }}
      >
        <div>
          <Label>Nombre</Label>
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </div>
        <div>
          <Label>Apellido</Label>
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </div>
        <div>
          <Label>Cargo</Label>
          <Input value={form.title ?? ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div>
          <Label>Rol de decisión</Label>
          <Select
            value={form.decisionRole ?? ""}
            onChange={(e) => setForm({ ...form, decisionRole: (e.target.value || undefined) as never })}
          >
            <option value="">—</option>
            {DECISION_ROLES.map((r) => (
              <option key={r} value={r}>
                {formatStatusLabel(r)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <Label>Teléfono</Label>
          <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="col-span-2 flex gap-2">
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
      <div>
        <div className="font-medium">
          {contact.firstName} {contact.lastName} {contact.isPrimary && <Badge variant="primary">Principal</Badge>}
        </div>
        <div className="text-muted-foreground">
          {contact.title ?? "—"} {contact.decisionRole ? `· ${formatStatusLabel(contact.decisionRole)}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right text-muted-foreground">
          <div>{contact.email ?? "—"}</div>
          <div>{contact.phone ?? "—"}</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Editar
        </Button>
      </div>
    </div>
  );
}

function LogActivityForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [type, setType] = useState("NOTE");

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<ActivityItem>("/activities", {
        method: "POST",
        body: JSON.stringify({ entityType: "company", entityId: companyId, type, subject }),
      }),
    onSuccess: () => {
      toast({ title: "Actividad registrada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      setSubject("");
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo registrar la actividad", description: String(err), variant: "error" }),
  });

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (subject.trim()) mutation.mutate();
      }}
    >
      <Select className="w-32 shrink-0" value={type} onChange={(e) => setType(e.target.value)}>
        {["NOTE", "CALL", "EMAIL", "MEETING"].map((t) => (
          <option key={t} value={t}>
            {formatStatusLabel(t)}
          </option>
        ))}
      </Select>
      <Input placeholder="¿Qué pasó?" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <Button type="submit" size="sm" disabled={mutation.isPending}>
        Registrar
      </Button>
    </form>
  );
}

export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen, setEditOpen] = useState(false);

  const { data: company, isLoading } = useQuery({
    queryKey: ["company", id],
    queryFn: () => apiFetch<CompanyDetail>(`/companies/${id}`),
    enabled: !!id,
  });

  if (isLoading || !company) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div>
      <PageHeader
        title={company.name}
        description={`${company.industryName}${company.city && company.state ? ` · ${company.city}, ${company.state}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(company.status)}>{formatStatusLabel(company.status)}</Badge>
            <CompanyOriginBadge origin={company.origin} title={company.sourceUrl ?? undefined} />
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Editar
            </Button>
          </div>
        }
      />

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar empresa">
        <EditCompanyForm company={company} onDone={() => setEditOpen(false)} />
      </Drawer>

      <div className="mb-4 flex gap-1 rounded-md border border-border bg-secondary/40 p-1 w-fit">
        {TABS.map((t) => (
          <Button
            key={t}
            variant={tab === t ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab(t)}
            className={cn(tab !== t && "text-muted-foreground")}
          >
            {TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Detalles</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sitio web</span>
                <span>{company.website ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Teléfono</span>
                <span>{company.phone ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tamaño estimado</span>
                <span>{company.estimatedSize ? formatStatusLabel(company.estimatedSize) : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Score comercial</span>
                <span>{company.commercialScore ?? "—"}</span>
              </div>
              {company.commercialScoreReason && (
                <p className="rounded-md bg-secondary/40 p-2 text-xs text-muted-foreground">
                  {company.commercialScoreReason}
                </p>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Necesidades posibles</span>
                <span>{company.possibleCategoryNames.join(", ") || "—"}</span>
              </div>
              <div className="pt-2">
                <span className="text-muted-foreground">Notas</span>
                <p className="mt-1">{company.notes ?? "—"}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Procedencia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Origen</span>
                <CompanyOriginBadge origin={company.origin} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estado de verificación</span>
                <span>{VERIFICATION_LABELS[company.verificationStatus] ?? company.verificationStatus}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confianza</span>
                <span>{company.confidenceScore != null ? `${Math.round(company.confidenceScore * 100)}%` : "No disponible"}</span>
              </div>
              {EXTERNAL_ORIGINS.has(company.origin) && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Fuente</span>
                    <span className="truncate">
                      {company.sourceUrl ? (
                        <a href={company.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                          {company.sourceUrl}
                        </a>
                      ) : (
                        "No disponible"
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Descubierta el</span>
                    <span>{company.discoveredAt ? new Date(company.discoveredAt).toLocaleString() : "No disponible"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Última verificación</span>
                    <span>{company.lastVerifiedAt ? new Date(company.lastVerifiedAt).toLocaleString() : "No disponible"}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email</span>
                <span>{company.email ?? "No disponible"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Próximos seguimientos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {company.upcomingFollowUps.length ? (
                company.upcomingFollowUps.map((f) => (
                  <div key={f.id} className="flex justify-between border-b border-border pb-2 last:border-0">
                    <span>{formatStatusLabel(f.type)}</span>
                    <span className="text-muted-foreground">{new Date(f.dueDate).toLocaleDateString()}</span>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">Sin seguimientos pendientes.</p>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Sales Agent</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <AgentTaskAction
                label="Calificar con IA"
                runningLabel="Calificando…"
                input={{ type: "score_company", input: { companyId: company.id } }}
                onSettled={() => {
                  queryClient.invalidateQueries({ queryKey: ["company", company.id] });
                  queryClient.invalidateQueries({ queryKey: ["companies"] });
                }}
                renderResult={(output) => {
                  const result = output as { score: number; rationale: string };
                  return (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Score {result.score}/100 — {result.rationale}
                    </p>
                  );
                }}
              />
              <AgentTaskAction
                label="Buscar señales"
                runningLabel="Buscando…"
                input={{ type: "detect_hiring_signals", input: { companyId: company.id } }}
                renderResult={(output) => {
                  const result = output as { signals: string[]; confidence: number };
                  return (
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <p>Confianza: {Math.round(result.confidence * 100)}%</p>
                      {result.signals.length ? (
                        <ul className="list-disc space-y-1 pl-4">
                          {result.signals.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>Sin señales detectadas en datos internos.</p>
                      )}
                    </div>
                  );
                }}
              />
              <AgentTaskAction
                label="Identificar contactos"
                runningLabel="Buscando…"
                input={{ type: "identify_contacts", input: { companyId: company.id } }}
                renderResult={(output) => {
                  const result = output as { contactIds: string[] };
                  const names = result.contactIds
                    .map((id) => company.contacts.find((c) => c.id === id))
                    .filter((c): c is CompanyDetail["contacts"][number] => !!c)
                    .map((c) => `${c.firstName} ${c.lastName}`);
                  return (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {names.length ? names.join(", ") : "Sin contactos con ese rol todavía."}
                    </p>
                  );
                }}
              />
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Prospecting Agent</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-xs text-muted-foreground">
                Corre la cadena completa: calificar → crear lead → crear oportunidad → crear seguimiento → preparar
                correo (que siempre queda pendiente de aprobación). Igual que el scheduler, solo que ahora mismo.
              </p>
              <AgentTaskAction
                label="Analizar ahora"
                runningLabel="Procesando pipeline…"
                endpoint="/prospecting/tasks"
                input={{ companyId: company.id }}
                onSettled={(task) => {
                  if (task.status === "DONE") {
                    queryClient.invalidateQueries({ queryKey: ["company", company.id] });
                    queryClient.invalidateQueries({ queryKey: ["companies"] });
                    queryClient.invalidateQueries({ queryKey: ["leads"] });
                    queryClient.invalidateQueries({ queryKey: ["approvals"] });
                  }
                }}
                renderResult={(output) => {
                  const result = output as { leadId: string; opportunityId: string | null; followUpId: string | null };
                  return (
                    <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                      Pipeline completo: lead, oportunidad{result.opportunityId ? "" : " (no aplicable)"} y
                      seguimiento creados, borrador de correo pendiente de aprobación.
                    </p>
                  );
                }}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "contacts" && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <AddContactForm companyId={company.id} onDone={() => {}} />
            <div className="space-y-2">
              {company.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} companyId={company.id} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "opportunities" && (
        <Card>
          <CardContent className="space-y-2 p-4">
            {company.opportunities.length ? (
              company.opportunities.map((o) => (
                <div key={o.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span className="font-medium">{o.title}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">{o.estimatedRevenue ? `$${o.estimatedRevenue}` : "—"}</span>
                    <Badge variant={statusVariant(o.stage)}>{formatStatusLabel(o.stage)}</Badge>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin oportunidades todavía.</p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "followups" && (
        <Card>
          <CardContent className="space-y-2 p-4">
            {company.upcomingFollowUps.length ? (
              company.upcomingFollowUps.map((f) => (
                <div key={f.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span>{formatStatusLabel(f.type)}</span>
                  <span className="text-muted-foreground">{f.notes}</span>
                  <span className="text-muted-foreground">{new Date(f.dueDate).toLocaleDateString()}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Sin seguimientos pendientes.</p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "activity" && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <LogActivityForm companyId={company.id} onDone={() => {}} />
            <Timeline items={company.recentActivity} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
