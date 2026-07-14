import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActivityItem,
  CandidateDetail,
  CandidateStatusValue,
  ConvertCandidateToWorkerResult,
  JobCategoryListItem,
  UpdateCandidateInput,
} from "@ai-staffing-os/shared";
import { CANDIDATE_STATUS_TRANSITIONS } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Timeline } from "@/components/shared/Timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { ArrowLeft } from "lucide-react";

function EditCandidateForm({ candidate, onDone }: { candidate: CandidateDetail; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: categories } = useQuery({
    queryKey: ["job-categories"],
    queryFn: () => apiFetch<JobCategoryListItem[]>("/job-categories"),
  });

  const [form, setForm] = useState<UpdateCandidateInput>({
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    email: candidate.email ?? "",
    phone: candidate.phone ?? "",
    city: candidate.city ?? "",
    state: candidate.state ?? "",
    zip: candidate.zip ?? "",
    categoryIds: candidate.categoryIds,
    yearsExperience: candidate.yearsExperience ?? undefined,
    resumeUrl: candidate.resumeUrl ?? "",
    source: candidate.source ?? "",
    smsOptIn: candidate.smsOptIn,
  });

  const mutation = useMutation({
    mutationFn: (input: UpdateCandidateInput) =>
      apiFetch(`/candidates/${candidate.id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      toast({ title: "Candidate actualizado", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      onDone();
    },
    onError: (err) => toast({ title: "No se pudo actualizar", description: String(err), variant: "error" }),
  });

  function toggleCategory(id: string) {
    setForm((f) => ({
      ...f,
      categoryIds: f.categoryIds?.includes(id) ? f.categoryIds.filter((c) => c !== id) : [...(f.categoryIds ?? []), id],
    }));
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(form);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Nombre</Label>
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </div>
        <div>
          <Label>Apellido</Label>
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Email</Label>
          <Input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <Label>Teléfono</Label>
          <Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Ciudad</Label>
          <Input value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div>
          <Label>Estado</Label>
          <Input value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        </div>
        <div>
          <Label>ZIP</Label>
          <Input value={form.zip ?? ""} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Años de experiencia</Label>
          <Input
            type="number"
            min={0}
            value={form.yearsExperience ?? ""}
            onChange={(e) => setForm({ ...form, yearsExperience: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div>
          <Label>Origen</Label>
          <Input value={form.source ?? ""} onChange={(e) => setForm({ ...form, source: e.target.value })} />
        </div>
      </div>
      <div>
        <Label>Resume URL</Label>
        <Input value={form.resumeUrl ?? ""} onChange={(e) => setForm({ ...form, resumeUrl: e.target.value })} />
      </div>
      {categories && categories.length > 0 && (
        <div>
          <Label>Categorías</Label>
          <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-md border border-border p-2">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border"
                  checked={form.categoryIds?.includes(c.id) ?? false}
                  onChange={() => toggleCategory(c.id)}
                />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}

function ConvertToWorkerModal({
  candidate,
  onClose,
  onConverted,
}: {
  candidate: CandidateDetail;
  onClose: () => void;
  onConverted: (workerId: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [employmentType, setEmploymentType] = useState<"W2" | "C1099">("W2");
  const [defaultPayRate, setDefaultPayRate] = useState<number>(0);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<ConvertCandidateToWorkerResult>(`/candidates/${candidate.id}/convert-to-worker`, {
        method: "POST",
        body: JSON.stringify({ employmentType, defaultPayRate }),
      }),
    onSuccess: (result) => {
      toast({
        title: result.alreadyConverted ? "Este Candidate ya había sido convertido" : "Candidate convertido a Worker",
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["candidate", candidate.id] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      onConverted(result.worker.id);
    },
    onError: (err) => toast({ title: "No se pudo convertir", description: String(err), variant: "error" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-md p-4">
        <p className="text-sm font-medium">Convertir a Worker: {candidate.firstName} {candidate.lastName}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Esto crea un registro real de Worker vinculado a este Candidate. No crea ninguna Assignment ni inicia
          Payroll — eso ocurre en un bloque posterior. Los datos de contacto, ubicación y categorías siguen
          viviendo únicamente en el Candidate; el Worker los muestra por la relación, sin duplicarlos.
        </p>
        <div className="mt-3 rounded-md border border-border bg-muted/30 p-2 text-xs">
          <p className="font-medium">Se usará tal cual (sin copiar/duplicar):</p>
          <p className="text-muted-foreground">
            {candidate.firstName} {candidate.lastName} · {candidate.categoryNames.join(", ") || "sin categoría"}
          </p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="employmentType">Employment type *</Label>
            <Select id="employmentType" value={employmentType} onChange={(e) => setEmploymentType(e.target.value as "W2" | "C1099")}>
              <option value="W2">W2</option>
              <option value="C1099">1099</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="defaultPayRate">Default pay rate *</Label>
            <Input
              id="defaultPayRate"
              type="number"
              min={0.01}
              step="0.01"
              required
              value={defaultPayRate}
              onChange={(e) => setDefaultPayRate(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="sm" disabled={mutation.isPending || defaultPayRate <= 0} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Convirtiendo…" : "Confirmar conversión"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function CandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertedWorkerId, setConvertedWorkerId] = useState<string | null>(null);

  const { data: candidate, isLoading } = useQuery({
    queryKey: ["candidate", id],
    queryFn: () => apiFetch<CandidateDetail>(`/candidates/${id}`),
    enabled: !!id,
  });

  const { data: activity } = useQuery({
    queryKey: ["candidate-activity", id],
    queryFn: () => apiFetch<ActivityItem[]>(`/activities?entityType=candidate&entityId=${id}`),
    enabled: !!id,
  });

  const statusMutation = useMutation({
    mutationFn: (status: CandidateStatusValue) =>
      apiFetch(`/candidates/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: (_data, status) => {
      toast({ title: `Estado actualizado a ${formatStatusLabel(status)}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["candidate", id] });
      queryClient.invalidateQueries({ queryKey: ["candidate-activity", id] });
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
    },
    onError: (err) => toast({ title: "No se pudo cambiar el estado", description: String(err), variant: "error" }),
  });

  if (isLoading || !candidate) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  const permissions = currentUser?.permissions ?? [];
  const canConvert = permissions.includes("candidates.update") && permissions.includes("workers.create");
  const canViewWorker = permissions.includes("workers.view");
  const allowedNext = CANDIDATE_STATUS_TRANSITIONS[candidate.status];
  const workerId = convertedWorkerId ?? candidate.workerId;

  return (
    <div>
      <Link to="/candidates" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        Candidates
      </Link>

      <PageHeader
        title={`${candidate.firstName} ${candidate.lastName}`}
        description={candidate.categoryNames.join(", ") || "Sin categoría asignada"}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(candidate.status)}>{formatStatusLabel(candidate.status)}</Badge>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Editar
            </Button>
          </div>
        }
      />

      {allowedNext.length > 0 && (
        <Card className="mb-4 p-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Cambiar estado</p>
          <div className="flex flex-wrap gap-2">
            {allowedNext.map((next) => (
              <Button
                key={next}
                variant="outline"
                size="sm"
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate(next)}
              >
                {formatStatusLabel(next)}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {/* F5.2 (aprobado): PLACED nunca es un botón de estado más — la
          conversión a Worker es su propia acción, separada, con su propio
          diálogo de confirmación. */}
      {workerId ? (
        <Card className="mb-4 p-3">
          <p className="text-sm">
            Este Candidate ya fue convertido a Worker.{" "}
            {canViewWorker ? (
              <Link to={`/workers/${workerId}`} className="font-medium text-primary underline">
                Ver Worker
              </Link>
            ) : (
              <span className="text-muted-foreground">No tienes permiso para ver el detalle del Worker.</span>
            )}
          </p>
        </Card>
      ) : candidate.status === "QUALIFIED" ? (
        <Card className="mb-4 p-3">
          {canConvert ? (
            <>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Conversión</p>
              <Button size="sm" onClick={() => setConvertOpen(true)}>
                Convert to Worker
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Qualified — awaiting worker conversion (requiere un rol con permiso para convertir).
            </p>
          )}
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Perfil</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{candidate.email ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Teléfono</span>
              <span>{candidate.phone ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ubicación</span>
              <span>
                {candidate.city && candidate.state ? `${candidate.city}, ${candidate.state} ${candidate.zip ?? ""}` : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Idiomas</span>
              <span>{candidate.languages.join(", ").toUpperCase() || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Años de experiencia</span>
              <span>{candidate.yearsExperience ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Origen</span>
              <span>{candidate.source ?? "—"}</span>
            </div>
            {candidate.resumeUrl && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Resume</span>
                <a href={candidate.resumeUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                  Ver
                </a>
              </div>
            )}
            {candidate.aiSummary && (
              <div className="pt-2">
                <span className="text-muted-foreground">AI Summary</span>
                <p className="mt-1">{candidate.aiSummary}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado y trazabilidad</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">AI Score</span>
              <span>{candidate.aiScore != null ? candidate.aiScore.toFixed(1) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creado por</span>
              <span>{candidate.createdByName ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creado</span>
              <span>{new Date(candidate.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Actualizado</span>
              <span>{new Date(candidate.updatedAt).toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Actividad</CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline items={activity ?? []} />
          </CardContent>
        </Card>
      </div>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} title="Editar Candidate">
        <EditCandidateForm candidate={candidate} onDone={() => setEditOpen(false)} />
      </Drawer>

      {convertOpen && (
        <ConvertToWorkerModal
          candidate={candidate}
          onClose={() => setConvertOpen(false)}
          onConverted={(newWorkerId) => {
            setConvertedWorkerId(newWorkerId);
            setConvertOpen(false);
          }}
        />
      )}
    </div>
  );
}
