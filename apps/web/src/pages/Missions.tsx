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
  // Corrección estructural (misión Iowa, 2026-07-13): un resultado
  // parcial (ej. empresas encontradas, pero sin ningún contacto) nunca
  // debe verse como un COMPLETED verde silencioso — badge de advertencia.
  PARTIAL: "warning",
  FAILED: "danger",
  // F7.2: un plan generado no es ni un éxito ni una ejecución en curso —
  // badge propio, nunca confundido con COMPLETED/RUNNING.
  PLANNED: "info",
  // F7.3: el ejecutor dinámico corrió las queries correctamente pero cero
  // candidatos pasaron validación/dedup — nunca se ve como COMPLETED
  // (verde) ni como FAILED (rojo), badge neutro propio.
  NO_RESULTS: "neutral",
  // F7.3: no había ninguna capacidad real disponible ANTES de arrancar
  // (sin estado soportado, sin queries, sin proveedor con cobertura).
  BLOCKED: "warning",
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

  // F7.2: modo solo-planificación — interpreta + arma el Mission Plan,
  // nunca ejecuta discovery/contactos/campañas. Mismo formulario, un
  // endpoint distinto (ver mission-planning.ts).
  const planMutation = useMutation({
    mutationFn: (text: string) =>
      apiFetch<MissionListItem>("/missions/plan", { method: "POST", body: JSON.stringify({ instruction: text }) }),
    onSuccess: (mission) => {
      toast({
        title: "Plan generado — todavía no ejecutado",
        description: `Interpretado: ${mission.industryNames.join(", ") || "sin industria real de bucket"}${mission.state ? ` · ${mission.state}` : ""}`,
        variant: "success",
      });
      setInstruction("");
      queryClient.invalidateQueries({ queryKey: ["missions"] });
    },
    onError: (err) => toast({ title: "No se pudo generar el plan", description: String(err), variant: "error" }),
  });

  const isBusy = mutation.isPending || planMutation.isPending;

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
        <div className="flex flex-wrap gap-2">
          <Button disabled={!instruction.trim() || isBusy} onClick={() => mutation.mutate(instruction)}>
            {mutation.isPending ? "Interpretando…" : "Lanzar misión"}
          </Button>
          <Button
            variant="outline"
            disabled={!instruction.trim() || isBusy}
            onClick={() => planMutation.mutate(instruction)}
            title="Interpreta la instrucción y arma el plan, pero no busca empresas ni contacta a nadie todavía"
          >
            {planMutation.isPending ? "Planificando…" : "Solo planificar (sin ejecutar)"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          El CEO Agent interpreta la instrucción y delega a Campaign, Sales, Outreach y Market Intelligence Agent en
          una secuencia fija — nunca envía nada sin aprobación humana. Solo una misión activa por día.
          "Solo planificar" usa el intérprete determinista nuevo y se detiene después de guardar el plan — cero
          búsquedas, cero contactos, cero campañas.
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
    mission.missionState === "COMPLETED" ||
    mission.missionState === "PARTIAL" ||
    mission.missionState === "CANCELLED" ||
    mission.missionState === "FAILED" ||
    // F7.2: un plan generado no tiene nada corriendo que pausar/cancelar
    // — la única forma de "ejecutarlo" de verdad todavía no existe
    // (fuera de alcance de F7.2, ver plan §API).
    mission.missionState === "PLANNED" ||
    // F7.3: el ejecutor dinámico corre de punta a punta de forma síncrona
    // (ver mission-executor.ts) — cuando termina, no queda nada en vuelo
    // que pausar/cancelar/reanudar, sin importar en cuál de estos 2
    // estados haya cerrado.
    mission.missionState === "NO_RESULTS" ||
    mission.missionState === "BLOCKED";
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

function TagList({ label, items, variant = "neutral" }: { label: string; items: string[]; variant?: "neutral" | "info" | "warning" | "danger" | "success" }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} variant={variant}>
            {item}
          </Badge>
        ))}
      </div>
    </div>
  );
}

/**
 * F7.2: "Interpretación del CEO" — muestra el StructuredIntent
 * determinista (F7.1), nunca los resultados de una ejecución (todavía
 * no corrió ninguna). Presente únicamente cuando la misión pasó por
 * planMissionOnly (detail.ceoIntent !== null).
 */
function CeoIntentSection({ intent }: { intent: NonNullable<MissionDetail["ceoIntent"]> }) {
  return (
    <div className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">Interpretación del CEO</p>
        <Badge variant={intent.confidence >= 0.7 ? "success" : intent.confidence >= 0.4 ? "warning" : "danger"}>
          Confianza {Math.round(intent.confidence * 100)}%
        </Badge>
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Objetivo: </span>
        {formatStatusLabel(intent.objective.type)}
        {intent.objective.targetCompanyCount ? ` · ${intent.objective.targetCompanyCount} empresas` : ""}
      </p>
      <TagList label="Tipos de empresa" items={intent.companyTypes} />
      <TagList label="Industrias (CRM)" items={intent.industries} variant="info" />
      <TagList label="Actividades de negocio" items={intent.businessActivities} />
      <TagList label="Puestos objetivo" items={intent.targetJobTitles} />
      <TagList label="Señales de contratación" items={intent.hiringSignals} />
      <TagList label="Decisores" items={intent.decisionRoles} />
      <TagList label="Ciudades" items={intent.preferredCities} />
      <TagList label="Estados" items={intent.states} />
      <TagList label="Exclusiones" items={intent.exclusions} variant="danger" />
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge variant={intent.restrictions.allowCampaignCreation ? "neutral" : "warning"}>
          Campañas: {intent.restrictions.allowCampaignCreation ? "permitidas" : "bloqueadas"}
        </Badge>
        <Badge variant={intent.restrictions.allowOpportunityCreation ? "neutral" : "warning"}>
          Oportunidades: {intent.restrictions.allowOpportunityCreation ? "permitidas" : "bloqueadas"}
        </Badge>
        <Badge variant={intent.restrictions.allowOutreach ? "neutral" : "warning"}>
          Outreach: {intent.restrictions.allowOutreach ? "permitido" : "bloqueado"}
        </Badge>
        <Badge variant={intent.restrictions.allowMessageSending ? "neutral" : "warning"}>
          Mensajes: {intent.restrictions.allowMessageSending ? "permitidos" : "bloqueados"}
        </Badge>
      </div>
      {intent.ambiguities.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">Ambigüedades</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
            {intent.ambiguities.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {intent.unsupportedCapabilities.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-red-600 dark:text-red-400">Capacidades no soportadas</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
            {intent.unsupportedCapabilities.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** F7.2: "Plan de misión" — el MissionPlan (F7.1), declarativo, nunca ejecutado en esta fase. */
function MissionPlanSection({
  plan,
  warnings,
}: {
  plan: NonNullable<MissionDetail["missionPlan"]>;
  warnings: string[];
}) {
  const providers = Array.from(new Set(plan.fallbackStrategy.map((f) => f.provider)));
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan de misión</p>
      <p className="text-sm">{plan.rationale}</p>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Pasos (en orden)</p>
        <ol className="mt-1 list-inside list-decimal space-y-0.5 text-sm">
          {plan.steps.map((step) => (
            <li key={step}>
              {formatStatusLabel(step)}
              {plan.requiredSteps.includes(step) ? (
                <span className="ml-1 text-[11px] text-muted-foreground">(obligatorio)</span>
              ) : (
                <span className="ml-1 text-[11px] text-muted-foreground">(opcional)</span>
              )}
            </li>
          ))}
        </ol>
      </div>
      {plan.searchQueries.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Queries previstas</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {plan.searchQueries.map((q, i) => (
              <Badge key={i} variant="neutral">
                {q.searchTerm}
              </Badge>
            ))}
          </div>
        </div>
      )}
      <TagList label="Proveedores previstos" items={providers} variant="info" />
      <TagList label="Estrategia de deduplicación" items={plan.dedupStrategy.map(formatStatusLabel)} />
      {plan.fallbackStrategy.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Fallback</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
            {plan.fallbackStrategy.map((f, i) => (
              <li key={i}>
                <span className="font-medium text-foreground">{f.provider}:</span> {f.whenUnavailable}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>Máx. empresas: {plan.stopConditions.maxCompanies}</span>
        <span>Máx. costo: ${plan.stopConditions.maxCostUsd.toFixed(2)}</span>
        <span>Máx. duración: {plan.stopConditions.maxDurationMinutes} min</span>
      </div>
      {warnings.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">Warnings</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const DISCOVERY_STATE_LABELS: Record<string, string> = {
  COMPLETED: "Completado — se alcanzó el número de empresas pedido",
  PARTIAL: "Parcial — se encontraron empresas, pero no se alcanzó el número pedido",
  NO_RESULTS: "Sin resultados — las queries corrieron correctamente, cero candidatos válidos",
  BLOCKED: "Bloqueado — no había capacidad real disponible antes de arrancar",
  FAILED: "Falló — error técnico inesperado",
};

/**
 * F7.3: "Plan ejecutado" — el reporte real del ejecutor dinámico
 * (mission-executor.ts): qué se ejecutó, cuánto costó, por qué se
 * detuvo. Presente únicamente cuando la misión pasó por el nuevo
 * ejecutor (detail.discoveryExecution !== null) — nunca se muestra para
 * misiones legacy/planned-only.
 */
function DiscoveryExecutionSection({ report }: { report: NonNullable<MissionDetail["discoveryExecution"]> }) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan ejecutado</p>
        <Badge variant={MISSION_STATE_VARIANTS[report.missionState] ?? "neutral"}>
          {formatStatusLabel(report.missionState)}
        </Badge>
      </div>
      <p className="text-sm">{DISCOVERY_STATE_LABELS[report.missionState] ?? report.missionState}</p>

      <div className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
        <div>
          <p className="text-base font-semibold tabular-nums">{report.queriesExecuted}</p>
          <p className="text-muted-foreground">Queries</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums">{report.rawResults}</p>
          <p className="text-muted-foreground">Resultados crudos</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums">{report.acceptedResults}</p>
          <p className="text-muted-foreground">Aceptados</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums">{report.rejectedResults}</p>
          <p className="text-muted-foreground">Rechazados</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums">
            {report.duplicatesWithinMission + report.duplicatesAlreadyInCrm}
          </p>
          <p className="text-muted-foreground">Duplicados</p>
        </div>
        <div>
          <p className="text-base font-semibold tabular-nums">${report.costUsd.toFixed(4)}</p>
          <p className="text-muted-foreground">Costo</p>
        </div>
      </div>

      {report.queryExecutions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Queries ejecutadas</p>
          <div className="space-y-1">
            {report.queryExecutions.map((q, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate" title={q.query}>
                    {q.query} {q.city ? `· ${q.city}` : ""} {q.state ? `· ${q.state}` : ""}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{q.provider ?? "sin proveedor"}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                  <span>Crudos: {q.rawResultCount}</span>
                  <span>Aceptados: {q.acceptedCount}</span>
                  <span>Rechazados: {q.rejectedCount}</span>
                  <span>Duplicados: {q.duplicateCount}</span>
                  {q.error && <span className="text-amber-600 dark:text-amber-400">Error: {q.error}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <TagList label="Proveedores usados" items={report.providersUsed} variant="info" />
      <TagList label="Proveedores omitidos" items={report.providersOmitted} variant="warning" />

      {report.rejectedCandidates.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Validación — candidatos rechazados</p>
          <div className="space-y-1">
            {report.rejectedCandidates.map((r, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium" title={r.name ?? undefined}>
                    {r.name ?? "(sin nombre)"}
                  </span>
                  <Badge variant="neutral">{Math.round(r.confidence * 100)}%</Badge>
                </div>
                <p className="mt-1 text-muted-foreground">{r.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <TagList label="Restricciones aplicadas" items={report.restrictionsApplied} variant="warning" />
      <TagList label="Limitaciones" items={report.limitations} />
      <p className="text-xs text-muted-foreground">Motivo de detención: {formatStatusLabel(report.stopReason)}</p>
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
          {detail.missionPhase === "PLANNED" && (
            <Badge variant="info" className="w-fit">
              Plan generado — todavía no ejecutado
            </Badge>
          )}
          {detail.ceoIntent && <CeoIntentSection intent={detail.ceoIntent} />}
          {detail.missionPlan && (
            <MissionPlanSection plan={detail.missionPlan} warnings={detail.ceoIntentMeta?.warnings ?? []} />
          )}
          {detail.discoveryExecution && <DiscoveryExecutionSection report={detail.discoveryExecution} />}
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
          {detail.restrictionNotes.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                Restricciones aplicadas
              </p>
              <ul className="list-inside list-disc space-y-0.5 text-sm">
                {detail.restrictionNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          {/* F7.2: una misión PLANNED no ejecutó nada — nunca se muestran
              empresas/contactos/costo de proveedores, aunque estos
              arreglos existan vacíos igual (serían 0 de todas formas,
              pero ocultarlos es la señal honesta pedida explícitamente). */}
          {detail.missionPhase !== "PLANNED" && (
          <>
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
            <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Contact Intelligence</p>
            {/* F7.3: Contact Intelligence nunca corrió para una misión
                ejecutada por el nuevo ejecutor dinámico — mostrar "0
                emails"/"0 contactos" acá sería engañoso (parecería que sí
                se buscó y no encontró nada). Mensaje explícito en su
                lugar. */}
            {detail.discoveryExecution ? (
              <p className="rounded-md border border-border p-2 text-xs text-muted-foreground">
                Contact Intelligence pendiente de una fase posterior.
              </p>
            ) : (
              <>
            <div className="grid grid-cols-4 gap-2 rounded-md border border-border p-2 text-center text-xs sm:grid-cols-7">
              <div>
                <p className="text-base font-semibold tabular-nums">{detail.contactStats.companiesDiscovered}</p>
                <p className="text-muted-foreground">Empresas</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">{detail.contactStats.contactsFound}</p>
                <p className="text-muted-foreground">Contactos</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">{detail.contactStats.contactsVerified}</p>
                <p className="text-muted-foreground">Verificados</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">{detail.contactStats.emailsFound}</p>
                <p className="text-muted-foreground">Emails</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">{detail.contactStats.linkedinFound}</p>
                <p className="text-muted-foreground">LinkedIn</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">${detail.contactStats.costUsd.toFixed(4)}</p>
                <p className="text-muted-foreground">Costo</p>
              </div>
              <div>
                <p className="text-base font-semibold tabular-nums">
                  {detail.contactStats.durationMs != null ? `${Math.round(detail.contactStats.durationMs / 1000)}s` : "—"}
                </p>
                <p className="text-muted-foreground">Tiempo</p>
              </div>
            </div>
            {detail.contactCoverage && detail.contactCoverage.companiesConsidered > 0 && (
              <div
                className={`mt-2 rounded-md border p-2 text-xs ${
                  detail.contactCoverage.companiesWithoutContactPoint > 0
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-emerald-500/30 bg-emerald-500/5"
                }`}
              >
                <p>
                  {detail.contactCoverage.companiesWithContactPoint}/{detail.contactCoverage.companiesConsidered} empresas
                  con al menos un punto de contacto real (nombrado o email organizacional).
                  {detail.contactCoverage.companiesWithoutContactPoint > 0 &&
                    ` ${detail.contactCoverage.companiesWithoutContactPoint} sin ninguno.`}
                </p>
                {detail.contactCoverage.providersOmitted.length > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    Proveedores no disponibles: {detail.contactCoverage.providersOmitted.join(" · ")}
                  </p>
                )}
              </div>
            )}
            <div className="mt-2 space-y-1.5">
              {detail.contacts.length ? (
                detail.contacts.map((c) => (
                  <div key={c.contactId} className="rounded-md border border-border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium" title={`${c.firstName} ${c.lastName}`}>
                        {c.firstName} {c.lastName} <span className="text-muted-foreground font-normal">· {c.companyName}</span>
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {c.confidenceScore != null && <Badge variant="neutral">{Math.round(c.confidenceScore * 100)}%</Badge>}
                        <Badge variant={c.verificationStatus === "CONFIRMED" ? "success" : "neutral"}>{formatStatusLabel(c.verificationStatus)}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {c.title && <span>{c.title}</span>}
                      {c.email && <span>✉ {c.email}</span>}
                      {c.phone && <span>☎ {c.phone}</span>}
                      {c.linkedinUrl && (
                        <a href={c.linkedinUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                          LinkedIn
                        </a>
                      )}
                      {c.source && <span>Fuente: {c.source}</span>}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">Sin contactos encontrados todavía.</p>
              )}
            </div>
              </>
            )}
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
          </>
          )}
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
