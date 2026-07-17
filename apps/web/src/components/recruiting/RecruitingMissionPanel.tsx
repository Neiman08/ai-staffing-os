import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ListChecks } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import { CandidatePipelineDrawer } from "./CandidatePipelineDrawer";
import type { CandidateMatchingApiResult, CandidateMatchRecord, ShortlistEntryRecord } from "./types";

/**
 * F8.11: Recruiting Mission UI -- panel principal embebido en el
 * detalle real de un Job Order (mismo patrón que MatchingPanel de F6.7:
 * "la IA propone, un humano decide"). Muestra, contra backend REAL:
 * - Matching y ranking de Candidates (F8.6) -- un NOT_QUALIFIED nunca
 *   aparece en la lista de recomendados.
 * - Shortlist revisable (F8.7) -- nunca rechaza definitivamente, nunca
 *   contacta a nadie.
 * Cada candidato es clickeable y abre `CandidatePipelineDrawer` con el
 * detalle de calificación/screening/entrevista/placement readiness.
 */

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "NOT_FOUND";
}

function CandidateMatchRow({ match, onSelect }: { match: CandidateMatchRecord; onSelect: (candidateId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(match.candidateId)}
        className="flex w-full flex-wrap items-center justify-between gap-2 rounded border border-border/70 p-3 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2">
          {match.rank !== null && <span className="text-xs font-semibold text-muted-foreground">#{match.rank}</span>}
          <span className="font-medium">{match.candidateId}</span>
          <Badge variant={statusVariant(match.qualificationStatus)}>{formatStatusLabel(match.qualificationStatus)}</Badge>
          {match.needsReview && <Badge variant="warning">Requiere revisión</Badge>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={statusVariant(match.confidence)}>{formatStatusLabel(match.confidence)}</Badge>
          <span className="text-sm font-semibold text-foreground">{match.score.toFixed(0)}</span>
          <span>/100</span>
        </div>
      </button>
    </li>
  );
}

function MatchingSection({ jobOrderId, onSelectCandidate }: { jobOrderId: string; onSelectCandidate: (candidateId: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const canView = currentUser?.permissions.includes("candidates.view") ?? false;
  const canRun = currentUser?.permissions.includes("candidates.update") ?? false;
  const [showExcluded, setShowExcluded] = useState(false);
  const queryKey = ["job-order-candidate-matching", jobOrderId];

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<CandidateMatchingApiResult>(`/job-orders/${jobOrderId}/matching`),
    enabled: canView,
    retry: false,
  });

  const runMutation = useMutation({
    mutationFn: () => apiFetch<CandidateMatchingApiResult>(`/job-orders/${jobOrderId}/matching`, { method: "POST" }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      toast({ title: `Matching calculado: ${result.ranked.length} candidato(s) recomendado(s)`, variant: "success" });
    },
    onError: (err) => toast({ title: "No se pudo calcular el matching", description: String(err), variant: "error" }),
  });

  if (!canView) return null;

  const neverRan = query.isError && isNotFoundError(query.error);
  const unexpectedError = query.isError && !isNotFoundError(query.error);
  const result = query.data;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Candidate Matching &amp; Ranking</span>
          {result && (
            <span className="text-xs font-normal normal-case text-muted-foreground">
              {new Date(result.calculatedAt).toLocaleString()}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canRun && (
          <Button size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending} aria-busy={runMutation.isPending}>
            <Sparkles className="h-4 w-4" />
            {runMutation.isPending ? "Calculando…" : result ? "Volver a calcular" : "Calcular Matching"}
          </Button>
        )}

        <div aria-live="polite">
          {query.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}
          {neverRan && !runMutation.isPending && (
            <p className="text-sm text-muted-foreground">Todavía no se calculó el matching para este Job Order.</p>
          )}
          {unexpectedError && <p role="alert" className="text-sm text-destructive">No se pudo cargar el matching.</p>}
        </div>

        {result && (
          <>
            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recomendados ({result.ranked.length})
              </h4>
              {result.ranked.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ningún candidato recomendado en esta corrida.</p>
              ) : (
                <ul className="space-y-2">
                  {result.ranked.map((m) => (
                    <CandidateMatchRow key={m.candidateId} match={m} onSelect={onSelectCandidate} />
                  ))}
                </ul>
              )}
            </div>

            {result.excluded.length > 0 && (
              <div>
                <button
                  type="button"
                  className="rounded text-xs font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={showExcluded}
                  onClick={() => setShowExcluded((v) => !v)}
                >
                  {showExcluded ? "Ocultar" : "Ver"} no recomendados ({result.excluded.length})
                </button>
                {showExcluded && (
                  <ul className="mt-2 space-y-2">
                    {result.excluded.map((m) => (
                      <CandidateMatchRow key={m.candidateId} match={m} onSelect={onSelectCandidate} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const SHORTLIST_STATUS_OPTIONS = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "HOLD", "REMOVED"] as const;

function ShortlistRow({
  entry,
  onSelect,
  canUpdate,
}: {
  entry: ShortlistEntryRecord;
  onSelect: (candidateId: string) => void;
  canUpdate: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["job-order-shortlist", entry.jobOrderId];

  const statusMutation = useMutation({
    mutationFn: (reviewStatus: string) =>
      apiFetch(`/shortlist/${entry.id}/review-status`, { method: "PATCH", body: JSON.stringify({ reviewStatus }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Estado de shortlist actualizado", variant: "success" });
    },
    onError: (err) => toast({ title: "Transición inválida", description: String(err), variant: "error" }),
  });

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 p-3 text-sm">
      <button type="button" onClick={() => onSelect(entry.candidateId)} className="flex items-center gap-2 text-left hover:underline">
        <span className="text-xs font-semibold text-muted-foreground">#{entry.rank}</span>
        <span className="font-medium">{entry.candidateId}</span>
      </button>
      <div className="flex items-center gap-2">
        <Badge variant={statusVariant(entry.reviewStatus)}>{formatStatusLabel(entry.reviewStatus)}</Badge>
        {canUpdate && (
          <Select
            className="h-7 w-auto py-0 text-xs"
            value=""
            onChange={(e) => {
              if (e.target.value) statusMutation.mutate(e.target.value);
              e.target.value = "";
            }}
            disabled={statusMutation.isPending}
            aria-label={`Cambiar estado de shortlist para ${entry.candidateId}`}
          >
            <option value="">Cambiar a…</option>
            {SHORTLIST_STATUS_OPTIONS.filter((s) => s !== entry.reviewStatus).map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
        )}
      </div>
    </li>
  );
}

function ShortlistSection({ jobOrderId, onSelectCandidate }: { jobOrderId: string; onSelectCandidate: (candidateId: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const canView = currentUser?.permissions.includes("candidates.view") ?? false;
  const canRun = currentUser?.permissions.includes("candidates.update") ?? false;
  const queryKey = ["job-order-shortlist", jobOrderId];

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<ShortlistEntryRecord[]>(`/job-orders/${jobOrderId}/shortlist`),
    enabled: canView,
  });

  const generateMutation = useMutation({
    mutationFn: () => apiFetch<ShortlistEntryRecord[]>(`/job-orders/${jobOrderId}/shortlist`, { method: "POST" }),
    onSuccess: (entries) => {
      queryClient.setQueryData(queryKey, entries);
      toast({ title: `Shortlist generada: ${entries.length} candidato(s)`, variant: "success" });
    },
    onError: (err) =>
      toast({
        title: "No se pudo generar la shortlist",
        description: isNotFoundError(err) ? "Calcula el matching primero." : String(err),
        variant: "error",
      }),
  });

  if (!canView) return null;

  const entries = query.data ?? [];

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Shortlist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canRun && (
          <Button size="sm" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
            <ListChecks className="h-4 w-4" />
            {generateMutation.isPending ? "Generando…" : entries.length > 0 ? "Refrescar shortlist" : "Generar Shortlist"}
          </Button>
        )}

        {query.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}

        {!query.isLoading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin shortlist todavía para este Job Order.</p>
        )}

        {entries.length > 0 && (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <ShortlistRow key={entry.id} entry={entry} onSelect={onSelectCandidate} canUpdate={canRun} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RecruitingMissionPanel({ jobOrderId }: { jobOrderId: string }) {
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  return (
    <>
      <MatchingSection jobOrderId={jobOrderId} onSelectCandidate={setSelectedCandidateId} />
      <ShortlistSection jobOrderId={jobOrderId} onSelectCandidate={setSelectedCandidateId} />
      <CandidatePipelineDrawer candidateId={selectedCandidateId} jobOrderId={jobOrderId} onClose={() => setSelectedCandidateId(null)} />
    </>
  );
}
