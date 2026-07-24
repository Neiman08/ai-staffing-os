import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { formatStatusLabel, statusVariant } from "@/lib/status";

/**
 * F25.2 (activación controlada, Prioridad 8): Pilot Mission Control
 * Center -- reusa el patrón visual exacto de Approvals.tsx/HumanReview.tsx
 * (PageHeader, Card/Badge/Button de @/components/ui, useQuery+useMutation
 * +useToast) contra los endpoints reales de Prioridad 1/6/8
 * (POST/GET/PATCH /api/v1/agents/missions,
 * GET /api/v1/agents/missions/:correlationId/timeline). Página nueva,
 * ningún componente compartido existente se modifica.
 */

// Mismo set exacto que SUPPORTED_STATE_CODES en
// apps/api/src/modules/ceo-intelligence/geo.ts -- duplicado deliberado
// (una lista de 9 códigos fijos no amerita un endpoint propio).
const SUPPORTED_STATES: Record<string, string> = {
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  NE: "Nebraska",
  WI: "Wisconsin",
  MI: "Michigan",
  OH: "Ohio",
  MO: "Missouri",
  TX: "Texas",
};

interface PilotMissionSummary {
  missionTaskId: string;
  correlationId: string;
  status: string;
  controlState: "ACTIVE" | "PAUSED" | "CANCELED";
  pilotMeta: { name?: string; trade?: string; region?: { state: string; cities: string[] }; companyLimit?: number } | null;
  createdAt: string;
  completedAt: string | null;
}

interface PilotMissionResult {
  missionTaskId: string;
  correlationId: string;
  status: string;
  alreadyExisted: boolean;
  dryRun: boolean;
  plan?: { stopConditions?: { maxCostUsd?: number } };
}

type MissionTimelineEntry =
  | { kind: "task"; id: string; type: string; status: string; attempt: number; lastErrorCategory: string | null; causationId: string | null; createdAt: string; completedAt: string | null }
  | { kind: "event"; id: string; type: string; causationId: string | null; processedAt: string | null; createdAt: string; entityType: string | null; entityId: string | null };

const CONTROL_BADGE_VARIANT: Record<PilotMissionSummary["controlState"], "success" | "warning" | "danger"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CANCELED: "danger",
};

function CreateMissionDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", industry: "", trade: "", state: "IL", cities: "", companyLimit: 5, dryRun: false });
  const [planPreview, setPlanPreview] = useState<PilotMissionResult | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiFetch<PilotMissionResult>("/agents/missions", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          industry: form.industry,
          trade: form.trade,
          region: { state: form.state, cities: form.cities.split(",").map((c) => c.trim()).filter(Boolean) },
          companyLimit: form.companyLimit,
          autonomyLevel: 1,
          dryRun: form.dryRun,
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    onSuccess: (result) => {
      if (result.dryRun) {
        setPlanPreview(result);
        toast({ title: "Plan generado (dry-run)", description: "No se creó ninguna AgentTask real.", variant: "success" });
        return;
      }
      toast({ title: "Misión piloto creada", description: `AgentTask ${result.missionTaskId} en cola.`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["pilot-missions"] });
      onClose();
    },
    onError: (err) => toast({ title: "No se pudo crear la misión", description: String(err), variant: "error" }),
  });

  const canSubmit = form.name.trim() && form.industry.trim() && form.trade.trim() && form.cities.trim() && form.companyLimit >= 1;

  return (
    <Drawer open={open} onClose={onClose} title="Nueva misión piloto">
      <div className="space-y-3 text-sm">
        <div>
          <Label htmlFor="mission-name">Nombre</Label>
          <Input id="mission-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Piloto contratistas eléctricos IL" />
        </div>
        <div>
          <Label htmlFor="mission-industry">Industria</Label>
          <Input id="mission-industry" value={form.industry} onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))} placeholder="CONSTRUCTION" />
        </div>
        <div>
          <Label htmlFor="mission-trade">Trade / rubro</Label>
          <Input id="mission-trade" value={form.trade} onChange={(e) => setForm((f) => ({ ...f, trade: e.target.value }))} placeholder="electrical contractors" />
          <p className="mt-1 text-xs text-muted-foreground">Debe coincidir con una entrada real de la taxonomía de negocio -- si no matchea, la misión se rechaza (nunca se inventa un plan sin evidencia).</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="mission-state">Estado</Label>
            <Select id="mission-state" value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}>
              {Object.entries(SUPPORTED_STATES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="mission-limit">Límite de empresas</Label>
            <Input
              id="mission-limit"
              type="number"
              min={1}
              max={100}
              value={form.companyLimit}
              onChange={(e) => setForm((f) => ({ ...f, companyLimit: Number(e.target.value) }))}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="mission-cities">Ciudades (separadas por coma)</Label>
          <Input id="mission-cities" value={form.cities} onChange={(e) => setForm((f) => ({ ...f, cities: e.target.value }))} placeholder="Chicago, Aurora" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={form.dryRun} onChange={(e) => setForm((f) => ({ ...f, dryRun: e.target.checked }))} />
          Dry-run -- solo genera el plan, no crea ninguna AgentTask real
        </label>

        {planPreview?.plan && (
          <div className="rounded-md border border-border bg-secondary/30 p-2.5 text-xs">
            <p className="font-medium">Plan generado (dry-run, nada se creó)</p>
            {planPreview.plan.stopConditions?.maxCostUsd !== undefined && (
              <p className="mt-1 text-muted-foreground">Presupuesto máximo: ${planPreview.plan.stopConditions.maxCostUsd}</p>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button size="sm" disabled={!canSubmit || create.isPending} onClick={() => create.mutate()}>
            {form.dryRun ? "Generar plan" : "Crear misión"}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          AUTONOMY LEVEL 1 -- solo Discovery, Contact Intelligence y Quality. Nunca envía emails ni ejecuta acciones externas.
        </p>
      </div>
    </Drawer>
  );
}

function MissionTimelineDrawer({ mission, onClose }: { mission: PilotMissionSummary | null; onClose: () => void }) {
  const { data: timeline, isLoading } = useQuery({
    queryKey: ["pilot-mission-timeline", mission?.correlationId],
    queryFn: () => apiFetch<MissionTimelineEntry[]>(`/agents/missions/${mission!.correlationId}/timeline`),
    enabled: mission !== null,
  });

  const companiesDiscovered = (timeline ?? []).filter((e): e is Extract<MissionTimelineEntry, { kind: "event" }> => e.kind === "event" && e.type === "company.discovered.v1");
  const humanReviewTasks = (timeline ?? []).filter((e): e is Extract<MissionTimelineEntry, { kind: "task" }> => e.kind === "task" && e.status === "HUMAN_REVIEW");

  return (
    <Drawer open={mission !== null} onClose={onClose} title={mission?.pilotMeta?.name ?? "Misión piloto"}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-4 text-sm">
          {companiesDiscovered.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Empresas descubiertas ({companiesDiscovered.length})</p>
              <ul className="space-y-1">
                {companiesDiscovered.map((e) => (
                  <li key={e.id}>
                    {e.entityId ? (
                      <Link to={`/companies/${e.entityId}`} className="text-primary hover:underline">
                        Ver empresa
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{e.id}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {humanReviewTasks.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              <p className="font-medium">{humanReviewTasks.length} tarea(s) esperando decisión humana</p>
              <Link to="/human-review" className="mt-1 inline-block underline">
                Ir al Human Review Center
              </Link>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline (tareas + eventos, orden cronológico)</p>
            {timeline && timeline.length > 0 ? (
              <ul className="space-y-1.5">
                {timeline.map((e) => (
                  <li key={`${e.kind}-${e.id}`} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-medium">{e.kind === "task" ? "Tarea" : "Evento"}:</span> {e.type}
                    </div>
                    {e.kind === "task" ? (
                      <Badge variant={statusVariant(e.status)}>{formatStatusLabel(e.status)}</Badge>
                    ) : (
                      <Badge variant={e.processedAt ? "success" : "neutral"}>{e.processedAt ? "Procesado" : "Pendiente"}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Sin actividad todavía.</p>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function PilotMissions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<PilotMissionSummary | null>(null);

  const { data: missions, isLoading } = useQuery({
    queryKey: ["pilot-missions"],
    queryFn: () => apiFetch<PilotMissionSummary[]>("/agents/missions"),
  });

  const controlAction = useMutation({
    mutationFn: (input: { missionTaskId: string; action: "pause" | "resume" | "cancel" }) =>
      apiFetch<PilotMissionSummary>(`/agents/missions/${input.missionTaskId}`, { method: "PATCH", body: JSON.stringify({ action: input.action }) }),
    onSuccess: () => {
      toast({ title: "Misión actualizada", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["pilot-missions"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar la misión", description: String(err), variant: "error" }),
  });

  return (
    <div>
      <PageHeader
        title="Pilot Missions"
        description="Activación controlada del pipeline autónomo real -- Discovery, Contact Intelligence y Quality. AUTONOMY LEVEL 1: nunca envía emails ni ejecuta acciones externas."
        action={<Button onClick={() => setCreateOpen(true)}>Nueva misión piloto</Button>}
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : missions && missions.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Trade / Región</TableHead>
                  <TableHead>Estado de la tarea raíz</TableHead>
                  <TableHead>Control</TableHead>
                  <TableHead>Creada</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {missions.map((m) => (
                  <TableRow key={m.missionTaskId} className="cursor-pointer" onClick={() => setSelected(m)}>
                    <TableCell className="font-medium">{m.pilotMeta?.name ?? m.missionTaskId}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.pilotMeta?.trade} · {m.pilotMeta?.region?.cities.join(", ")}, {m.pilotMeta?.region?.state}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(m.status)}>{formatStatusLabel(m.status)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={CONTROL_BADGE_VARIANT[m.controlState]}>{formatStatusLabel(m.controlState)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1.5">
                        {m.controlState === "ACTIVE" && (
                          <Button size="sm" variant="outline" disabled={controlAction.isPending} onClick={() => controlAction.mutate({ missionTaskId: m.missionTaskId, action: "pause" })}>
                            Pausar
                          </Button>
                        )}
                        {m.controlState === "PAUSED" && (
                          <Button size="sm" variant="outline" disabled={controlAction.isPending} onClick={() => controlAction.mutate({ missionTaskId: m.missionTaskId, action: "resume" })}>
                            Reanudar
                          </Button>
                        )}
                        {m.controlState !== "CANCELED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={controlAction.isPending}
                            onClick={() => {
                              if (window.confirm("¿Cancelar esta misión piloto? Se cancelan las tareas pendientes y no se crearán tareas nuevas.")) {
                                controlAction.mutate({ missionTaskId: m.missionTaskId, action: "cancel" });
                              }
                            }}
                          >
                            Cancelar
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">Todavía no hay misiones piloto -- crea la primera con el botón de arriba.</p>
      )}

      <CreateMissionDrawer open={createOpen} onClose={() => setCreateOpen(false)} />
      <MissionTimelineDrawer mission={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
