import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTaskDetail, MatchHistoryEntry, MatchRunResult, Paginated, WorkerMatchResult } from "@ai-staffing-os/shared";
import { Loader2, Sparkles } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { formatStatusLabel, statusVariant } from "@/lib/status";

// F6.7: integra el matching determinista (F6.3-F6.6) en el detalle real
// del Job Order — no existe una app/página separada. "La IA propone, un
// humano decide": esta sección solo lee y ejecuta el análisis; ninguna
// acción de acá crea una Assignment, cambia el status del Job Order/
// Worker, ni envía mensajes — ver plan §13 y docs/F6_AUTONOMOUS_
// RECRUITING_AND_OPERATIONS_PLAN.md.

// disqualifiers/requiredDocumentsMissing son keys lowercase_snake_case
// (ej. "date_overlap", "forklift_cert" — ver scoring.ts), a diferencia
// de los enums de Prisma que formatStatusLabel espera (UPPER_SNAKE);
// sin el toUpperCase() acá, formatStatusLabel deja la primera letra de
// cada palabra en minúscula ("date overlap" en vez de "Date Overlap").
function formatSnakeKey(key: string): string {
  return formatStatusLabel(key.toUpperCase());
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "NOT_FOUND";
}

function asMatchRunResult(output: unknown): MatchRunResult | null {
  if (!output || typeof output !== "object") return null;
  return output as MatchRunResult;
}

function WorkerMatchCard({ worker }: { worker: WorkerMatchResult }) {
  return (
    <Card className="border-border/70">
      <CardContent className="space-y-2 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            to={`/workers/${worker.workerId}`}
            className="font-medium text-primary underline underline-offset-2"
          >
            {worker.displayName}
          </Link>
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(worker.eligibility)}>{formatStatusLabel(worker.eligibility)}</Badge>
            <span className="text-lg font-semibold leading-none">{worker.finalScore.toFixed(0)}</span>
            <span className="text-xs text-muted-foreground">/100</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Score determinista: {worker.deterministicScore.toFixed(1)}</span>
          <span>
            Ajuste IA:{" "}
            {worker.llmAdjustment === null
              ? "—"
              : `${worker.llmAdjustment > 0 ? "+" : ""}${worker.llmAdjustment.toFixed(1)}`}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant={statusVariant(worker.availabilityStatus)}>
            {formatStatusLabel(worker.availabilityStatus)}
          </Badge>
          <Badge variant={statusVariant(worker.complianceStatus)}>{formatStatusLabel(worker.complianceStatus)}</Badge>
          <Badge variant="neutral">{worker.categoryAssessment.label}</Badge>
          <Badge variant="neutral">{worker.experienceAssessment.label}</Badge>
          <Badge variant="neutral">{worker.locationAssessment.label}</Badge>
          <Badge variant="neutral">{worker.payRateAssessment.label}</Badge>
        </div>

        <p>{worker.rationale}</p>

        {worker.strengths.length > 0 && (
          <p className="text-xs">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">Fortalezas: </span>
            <span className="text-muted-foreground">{worker.strengths.join(" · ")}</span>
          </p>
        )}
        {worker.gaps.length > 0 && (
          <p className="text-xs">
            <span className="font-medium text-amber-600 dark:text-amber-400">Brechas: </span>
            <span className="text-muted-foreground">{worker.gaps.join(" · ")}</span>
          </p>
        )}
        {worker.disqualifiers.length > 0 && (
          <p className="text-xs">
            <span className="font-medium text-destructive">Descalificadores: </span>
            <span className="text-muted-foreground">{worker.disqualifiers.map(formatSnakeKey).join(" · ")}</span>
          </p>
        )}
        {worker.requiredDocumentsMissing.length > 0 && (
          <p className="text-xs">
            <span className="font-medium text-destructive">Documentos faltantes: </span>
            <span className="text-muted-foreground">
              {worker.requiredDocumentsMissing.map(formatSnakeKey).join(" · ")}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ entry }: { entry: MatchHistoryEntry }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
      <Badge variant={statusVariant(entry.status)}>{formatStatusLabel(entry.status)}</Badge>
      <span className="text-muted-foreground">
        {entry.eligibleCount} elegible(s)
        {entry.topScore !== null ? ` · mejor score ${entry.topScore.toFixed(0)}` : ""}
      </span>
      <span className="text-muted-foreground">${entry.cost.toFixed(4)}</span>
    </li>
  );
}

export function MatchingPanel({ jobOrderId }: { jobOrderId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const canView = currentUser?.permissions.includes("matching.view") ?? false;
  const canRun = currentUser?.permissions.includes("matching.run") ?? false;

  const [withLlm, setWithLlm] = useState(false);
  const [showIneligible, setShowIneligible] = useState(false);

  const latestQuery = useQuery({
    queryKey: ["job-order-matching-latest", jobOrderId],
    queryFn: () => apiFetch<AgentTaskDetail>(`/job-orders/${jobOrderId}/matching/latest`),
    enabled: canView,
    retry: false,
  });

  const historyQuery = useQuery({
    queryKey: ["job-order-matching-history", jobOrderId],
    queryFn: () => apiFetch<Paginated<MatchHistoryEntry>>(`/job-orders/${jobOrderId}/matching/history?limit=20`),
    enabled: canView,
  });

  const runMutation = useMutation({
    mutationFn: () =>
      apiFetch<AgentTaskDetail>(`/job-orders/${jobOrderId}/matching/run`, {
        method: "POST",
        body: JSON.stringify({ withLlm }),
      }),
    onSuccess: (task) => {
      queryClient.setQueryData(["job-order-matching-latest", jobOrderId], task);
      queryClient.invalidateQueries({ queryKey: ["job-order-matching-history", jobOrderId] });
      toast({
        title: task.status === "DONE" ? "Matching ejecutado" : "El matching terminó con error",
        variant: task.status === "DONE" ? "success" : "error",
      });
    },
    onError: (err) => {
      toast({
        title: "No se pudo ejecutar el matching",
        description: err instanceof ApiError ? err.message : String(err),
        variant: "error",
      });
    },
  });

  // Payroll/Accounting/Sales/Marketing/HR: sin matching.view, la sección
  // ni siquiera se renderiza (equivalente en UI al 403 que ya devuelve
  // el backend si igual se llamara al endpoint).
  if (!canView) return null;

  const task = latestQuery.data;
  const result = task?.status === "DONE" ? asMatchRunResult(task.output) : null;
  const neverRan = latestQuery.isError && isNotFoundError(latestQuery.error);
  const unexpectedError = latestQuery.isError && !isNotFoundError(latestQuery.error);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Matching con IA</span>
          {result && (
            <span className="text-xs font-normal normal-case text-muted-foreground">
              {result.algorithmVersion} · {new Date(result.generatedAt).toLocaleString()}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canRun && (
          <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-xs">
              <Label htmlFor="matching-mode">Modo</Label>
              <Select
                id="matching-mode"
                value={withLlm ? "with-llm" : "deterministic"}
                onChange={(e) => setWithLlm(e.target.value === "with-llm")}
                disabled={runMutation.isPending}
              >
                <option value="deterministic">Solo determinista</option>
                <option value="with-llm">Determinista + revisión IA</option>
              </Select>
            </div>
            <Button
              size="sm"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              aria-busy={runMutation.isPending}
            >
              <Sparkles className="h-4 w-4" />
              {runMutation.isPending ? "Ejecutando…" : result ? "Volver a ejecutar" : "Ejecutar Matching"}
            </Button>
          </div>
        )}

        <div aria-live="polite">
          {runMutation.isPending && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Evaluando Workers del tenant contra este Job Order…
            </p>
          )}

          {latestQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}

          {neverRan && !runMutation.isPending && (
            <p className="text-sm text-muted-foreground">
              Todavía no se ejecutó ningún matching para este Job Order.
            </p>
          )}

          {unexpectedError && (
            <p role="alert" className="text-sm text-destructive">
              No se pudo cargar la última corrida.
            </p>
          )}

          {task?.status === "FAILED" && (
            <p role="alert" className="text-sm text-destructive">
              La última corrida falló: {task.errorMessage ?? "error desconocido"}
            </p>
          )}
        </div>

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={result.deterministicOnly ? "neutral" : "info"}>
                {result.deterministicOnly ? "Solo determinista" : `IA: ${formatStatusLabel(result.llmStatus)}`}
              </Badge>
              <Badge variant="neutral">Costo ${result.cost.usd.toFixed(4)}</Badge>
              <Badge variant="neutral">
                {result.eligibleWorkers.length} elegible(s) · {result.ineligibleWorkers.length} no elegible(s)
              </Badge>
            </div>

            {result.warnings.length > 0 && (
              <ul className="list-inside list-disc text-xs text-amber-600 dark:text-amber-400">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="space-y-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Candidatos elegibles ({result.eligibleWorkers.length})
              </h4>
              {result.eligibleWorkers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ningún Worker elegible en esta corrida.</p>
              ) : (
                <ul className="space-y-3">
                  {result.eligibleWorkers.map((w) => (
                    <li key={w.workerId}>
                      <WorkerMatchCard worker={w} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {result.ineligibleWorkers.length > 0 && (
              <div>
                <button
                  type="button"
                  className="rounded text-xs font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={showIneligible}
                  onClick={() => setShowIneligible((v) => !v)}
                >
                  {showIneligible ? "Ocultar" : "Ver"} no elegibles ({result.ineligibleWorkers.length})
                </button>
                {showIneligible && (
                  <ul className="mt-3 space-y-3">
                    {result.ineligibleWorkers.map((w) => (
                      <li key={w.workerId}>
                        <WorkerMatchCard worker={w} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <div className="border-t border-border pt-4">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Historial de corridas
          </h4>
          {historyQuery.data && historyQuery.data.items.length > 0 ? (
            <ul className="divide-y divide-border">
              {historyQuery.data.items.map((h) => (
                <HistoryRow key={h.taskId} entry={h} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Sin corridas todavía.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
