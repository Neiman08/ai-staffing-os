import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MissionDetail, MissionListItem } from "@ai-staffing-os/shared";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { formatStatusLabel } from "@/lib/status";
import { timeAgo } from "@/lib/agentTaskStats";
import { Sparkles } from "lucide-react";
import { CompanyOriginBadge } from "@/components/shared/CompanyOriginBadge";

const MISSION_STATE_VARIANTS: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  RUNNING: "info",
  PAUSED_BY_USER: "warning",
  PAUSED_BUDGET: "warning",
  CANCELLED: "neutral",
  COMPLETED: "success",
  FAILED: "danger",
};

function LaunchMissionForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState("");

  const mutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch<MissionListItem>("/missions", { method: "POST", body: JSON.stringify({ instruction: text }) }),
    onSuccess: (mission) => {
      toast({
        title: "Misión lanzada",
        description: `Interpretado: ${mission.industryNames.join(", ") || "sin industria específica"}${mission.state ? ` · ${mission.state}` : ""}`,
        variant: "success",
      });
      setInstruction("");
      queryClient.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (err) => toast({ title: "No se pudo lanzar la misión", description: String(err), variant: "error" }),
  });

  return (
    <Card className="card-hover border-primary/20 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          Dale una instrucción diaria al CEO Agent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder='Ej: "Hoy busca empresas de manufactura y warehouses en Illinois que puedan necesitar General Labor o Forklift Operators. Prioriza empresas con señales recientes de contratación y prepara la prospección comercial del día."'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
        />
        <Button disabled={!instruction.trim() || mutation.isPending} onClick={() => mutation.mutate(instruction)}>
          {mutation.isPending ? "Interpretando…" : "Lanzar misión"}
        </Button>
        <p className="text-xs text-muted-foreground">
          El CEO Agent interpreta la instrucción y delega a Campaign, Sales, Outreach y Market Intelligence Agent en
          una secuencia fija — nunca envía nada sin aprobación humana. Solo una misión activa por día.
        </p>
      </CardContent>
    </Card>
  );
}

function ObjectiveProgressBar({ objectiveProgress }: { objectiveProgress: MissionListItem["objectiveProgress"] }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{objectiveProgress.rawText || formatStatusLabel(objectiveProgress.type)}</span>
        <span>
          {objectiveProgress.current}
          {objectiveProgress.target ? ` / ${objectiveProgress.target}` : ""} {objectiveProgress.unit}
        </span>
      </div>
      {objectiveProgress.percentComplete != null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(100, objectiveProgress.percentComplete)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function MissionActions({ mission }: { mission: MissionListItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const actionMutation = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel" | "close_now" | "recover") =>
      apiFetch(`/missions/${mission.id}`, { method: "PATCH", body: JSON.stringify({ action }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (err) => toast({ title: "No se pudo actualizar la misión", description: String(err), variant: "error" }),
  });

  const isTerminal =
    mission.missionState === "COMPLETED" || mission.missionState === "CANCELLED" || mission.missionState === "FAILED";
  if (isTerminal) return null;

  return (
    <div className="flex items-center gap-2">
      {mission.missionState === "RUNNING" && (
        <Button variant="outline" size="sm" onClick={() => actionMutation.mutate("pause")}>
          Pausar
        </Button>
      )}
      {(mission.missionState === "PAUSED_BY_USER" || mission.missionState === "PAUSED_BUDGET") && (
        <Button variant="outline" size="sm" onClick={() => actionMutation.mutate("resume")}>
          Reanudar
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => actionMutation.mutate("cancel")}>
        Cancelar
      </Button>
      <Button size="sm" onClick={() => actionMutation.mutate("close_now")}>
        Cerrar ahora
      </Button>
      {mission.missionState === "RUNNING" && (
        <Button
          variant="outline"
          size="sm"
          title="Herramienta administrativa: fuerza el cierre de una misión atascada sin actividad, sin depender de ninguna llamada externa"
          onClick={() => actionMutation.mutate("recover")}
        >
          Recuperar
        </Button>
      )}
    </div>
  );
}

function MissionDetailDrawer({ missionId, onClose }: { missionId: string | null; onClose: () => void }) {
  const { data: detail } = useQuery({
    queryKey: ["mission", missionId],
    queryFn: () => apiFetch<MissionDetail>(`/missions/${missionId}`),
    enabled: !!missionId,
  });

  return (
    <Drawer open={!!missionId} onClose={onClose} title="Detalle de la misión">
      {detail && (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Instrucción original</p>
            <p className="text-sm">{detail.rawInstruction}</p>
          </div>
          {detail.unrecognizedTerms.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Términos no reconocidos</p>
              <p className="text-sm text-amber-600 dark:text-amber-400">{detail.unrecognizedTerms.join(", ")}</p>
            </div>
          )}
          {detail.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-red-600 dark:text-red-400">
                Error
              </p>
              <p className="text-sm">{detail.error}</p>
            </div>
          )}
          {detail.report && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Executive Report
              </p>
              <p className="text-sm">{detail.report}</p>
            </div>
          )}
          {detail.missionState === "RUNNING" && detail.progressUpdatedAt && (
            <p className="text-xs text-muted-foreground">Última actividad: {timeAgo(detail.progressUpdatedAt)}</p>
          )}
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Empresas seleccionadas ({detail.selectedCompanies.length})
            </p>
            <div className="space-y-1.5">
              {detail.selectedCompanies.length ? (
                detail.selectedCompanies.map((c) => (
                  <Link
                    key={c.companyId}
                    to={`/companies/${c.companyId}`}
                    className="block rounded-md border border-border p-2 text-xs hover:border-primary/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate" title={c.companyName}>
                        {c.companyName} <span className="text-muted-foreground">· {c.industryName}</span>
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {c.confidenceScore != null && (
                          <Badge variant="neutral">{Math.round(c.confidenceScore * 100)}%</Badge>
                        )}
                        <CompanyOriginBadge origin={c.origin} title={c.sourceUrl ?? undefined} />
                      </div>
                    </div>
                    {(c.website || c.phone || c.email || c.sourceUrl) && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {c.website && <span>🌐 {c.website}</span>}
                        {c.phone && <span>☎ {c.phone}</span>}
                        {c.email && <span>✉ {c.email}</span>}
                        <span>{formatStatusLabel(c.verificationStatus)}</span>
                      </div>
                    )}
                  </Link>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">Sin empresas seleccionadas todavía.</p>
              )}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Tareas delegadas ({detail.childTasks.length})
            </p>
            <div className="space-y-1.5">
              {detail.childTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
                >
                  <span>
                    {task.agentKey} · {formatStatusLabel(task.type)}
                  </span>
                  <Badge variant={task.status === "DONE" || task.status === "AWAITING_APPROVAL" ? "success" : "neutral"}>
                    {formatStatusLabel(task.status)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function MissionCard({ mission, onOpenDetail }: { mission: MissionListItem; onOpenDetail: () => void }) {
  return (
    <Card className="card-hover space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={mission.rawInstruction}>
            {mission.rawInstruction}
          </p>
          <p className="text-xs text-muted-foreground">
            {mission.industryNames.join(", ") || "Cualquier industria"}
            {mission.state ? ` · ${mission.state}` : ""}
            {mission.categoryNames.length ? ` · ${mission.categoryNames.join(", ")}` : ""}
          </p>
        </div>
        <Badge variant={MISSION_STATE_VARIANTS[mission.missionState] ?? "neutral"}>
          {formatStatusLabel(mission.missionState)}
        </Badge>
      </div>

      <ObjectiveProgressBar objectiveProgress={mission.objectiveProgress} />

      <div className="grid grid-cols-5 gap-2 text-center text-xs">
        <div>
          <p className="text-lg font-semibold tabular-nums">{mission.companiesTargeted}</p>
          <p className="text-muted-foreground">Empresas</p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">{mission.leadsCreated}</p>
          <p className="text-muted-foreground">Leads</p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">{mission.opportunitiesCreated}</p>
          <p className="text-muted-foreground">Oport.</p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">{mission.draftsAwaitingApproval}</p>
          <p className="text-muted-foreground">Borradores</p>
        </div>
        <div>
          <p className="text-lg font-semibold tabular-nums">${mission.costUsdSoFar.toFixed(4)}</p>
          <p className="text-muted-foreground">Costo IA</p>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2">
        <Button variant="ghost" size="sm" onClick={onOpenDetail}>
          Ver detalle
        </Button>
        <MissionActions mission={mission} />
      </div>
    </Card>
  );
}

export default function Missions() {
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: missions, isLoading } = useQuery({
    queryKey: ["missions"],
    queryFn: () => apiFetch<MissionListItem[]>("/missions"),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Daily Revenue Mission" description="El CEO Agent interpreta tu instrucción diaria y orquesta la prospección del día" />

      <LaunchMissionForm />

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Historial de misiones</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : missions?.length ? (
          <div className="space-y-3">
            {missions.map((m) => (
              <MissionCard key={m.id} mission={m} onOpenDetail={() => setDetailId(m.id)} />
            ))}
          </div>
        ) : (
          <Card className="p-6 text-center text-sm text-muted-foreground">Sin misiones todavía.</Card>
        )}
      </div>

      <MissionDetailDrawer missionId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
