import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatStatusLabel, statusVariant } from "@/lib/status";
import type {
  InterviewPreviewRecord,
  InterviewPreviewStatus,
  PlacementReadinessRecord,
  QualificationEvaluationResult,
  ScreeningPlanRecord,
} from "./types";

/**
 * F8.11: Recruiting Mission UI -- panel de detalle por candidato dentro
 * de un Job Order. Muestra, todo contra backend REAL (F8.2/F8.5/F8.8/
 * F8.9/F8.10, nunca datos inventados en el frontend):
 * - Qualification (evaluación en vivo, F8.2 -- solo lectura, nunca
 *   persiste; F8.5 es quien persiste el estado, ver la sección de
 *   matching/shortlist del panel principal).
 * - Screening plan (F8.8) -- preview de preguntas, nunca una
 *   entrevista real.
 * - Interview preview (F8.9) -- PREVIEW explícito, nunca envía nada.
 * - Placement readiness (F8.10) -- nunca crea Placement/Assignment ni
 *   activa un Worker; cualquier acción siguiente exige aprobación
 *   humana explícita (requiresApproval siempre true).
 */

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "NOT_FOUND";
}

function QualificationSection({ candidateId, jobOrderId }: { candidateId: string; jobOrderId: string }) {
  const query = useQuery({
    queryKey: ["candidate-qualification", candidateId, jobOrderId],
    queryFn: () => apiFetch<QualificationEvaluationResult>(`/candidates/${candidateId}/qualification/${jobOrderId}`),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Cargando calificación…</p>;
  if (query.isError) return <p role="alert" className="text-sm text-destructive">No se pudo evaluar la calificación.</p>;
  const result = query.data;
  if (!result) return null;

  return (
    <div className="space-y-2 text-sm">
      {result.reasons.map((r, i) => (
        <p key={i} className="text-muted-foreground">
          {r}
        </p>
      ))}
      {result.hardDisqualifiers.length > 0 && (
        <p>
          <span className="font-medium text-destructive">Descalificadores: </span>
          {result.hardDisqualifiers.join(" · ")}
        </p>
      )}
      {result.missingDocuments.length > 0 && (
        <p>
          <span className="font-medium text-amber-600 dark:text-amber-400">Documentos faltantes: </span>
          {result.missingDocuments.join(" · ")}
        </p>
      )}
      {result.expiredDocuments.length > 0 && (
        <p>
          <span className="font-medium text-destructive">Documentos vencidos: </span>
          {result.expiredDocuments.join(" · ")}
        </p>
      )}
      {result.strengths.length > 0 && (
        <p>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">Fortalezas: </span>
          {result.strengths.join(" · ")}
        </p>
      )}
    </div>
  );
}

function ScreeningSection({ candidateId, jobOrderId, canUpdate }: { candidateId: string; jobOrderId: string; canUpdate: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["candidate-screening-plan", candidateId, jobOrderId];

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<ScreeningPlanRecord>(`/candidates/${candidateId}/screening-plan/${jobOrderId}`),
    retry: false,
  });

  const generateMutation = useMutation({
    mutationFn: () => apiFetch<ScreeningPlanRecord>(`/candidates/${candidateId}/screening-plan/${jobOrderId}`, { method: "POST" }),
    onSuccess: (plan) => {
      queryClient.setQueryData(queryKey, plan);
      toast({ title: "Plan de screening generado", variant: "success" });
    },
    onError: (err) => toast({ title: "No se pudo generar el plan", description: String(err), variant: "error" }),
  });

  const neverGenerated = query.isError && isNotFoundError(query.error);

  return (
    <div className="space-y-3 text-sm">
      {canUpdate && (
        <Button size="sm" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
          {generateMutation.isPending ? "Generando…" : query.data ? "Regenerar plan" : "Generar plan de screening"}
        </Button>
      )}

      {query.isLoading && <p className="text-muted-foreground">Cargando…</p>}
      {neverGenerated && !query.data && <p className="text-muted-foreground">Todavía no se generó un plan de screening (PREVIEW -- nunca una entrevista real).</p>}

      {query.data && (
        <div className="space-y-3">
          {query.data.manualReviewFlags.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">{query.data.manualReviewFlags.join(" ")}</p>
          )}
          <ol className="list-inside list-decimal space-y-2">
            {query.data.questions.map((q) => (
              <li key={q.id}>
                <p className="font-medium">{q.question}</p>
                <p className="text-xs text-muted-foreground">Rationale: {q.rationale}</p>
                <p className="text-xs text-muted-foreground">Evidencia esperada: {q.expectedEvidence}</p>
              </li>
            ))}
          </ol>
          {query.data.riskFlags.length > 0 && (
            <p className="text-xs text-destructive">Riesgos: {query.data.riskFlags.join(" · ")}</p>
          )}
        </div>
      )}
    </div>
  );
}

const INTERVIEW_STATUS_OPTIONS: InterviewPreviewStatus[] = [
  "DRAFT",
  "NEEDS_AVAILABILITY",
  "READY_FOR_APPROVAL",
  "APPROVED_FOR_SEND",
  "CANCELLED",
];

function InterviewSection({ candidateId, jobOrderId, canUpdate }: { candidateId: string; jobOrderId: string; canUpdate: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["candidate-interview-preview", candidateId, jobOrderId];
  const [nextStatus, setNextStatus] = useState<InterviewPreviewStatus>("APPROVED_FOR_SEND");

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<InterviewPreviewRecord>(`/candidates/${candidateId}/interview-preview/${jobOrderId}`),
    retry: false,
  });

  // F8.11: propuesta simple de una ventana (mañana, 30 min, teléfono) --
  // el recruiter siempre puede editar los detalles reales llamando al
  // endpoint directamente; este botón es el "quick start" del preview.
  const generateMutation = useMutation({
    mutationFn: () => {
      const start = new Date();
      start.setDate(start.getDate() + 2);
      start.setHours(15, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return apiFetch<InterviewPreviewRecord>(`/candidates/${candidateId}/interview-preview/${jobOrderId}`, {
        method: "POST",
        body: JSON.stringify({
          proposedWindows: [{ start: start.toISOString(), end: end.toISOString() }],
          durationMinutes: 30,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          modality: "PHONE",
          participants: [{ role: "recruiter", name: "Recruiter" }],
        }),
      });
    },
    onSuccess: (preview) => {
      queryClient.setQueryData(queryKey, preview);
      toast({ title: "Preview de entrevista generado (nunca se envió nada real)", variant: "success" });
    },
    onError: (err) => toast({ title: "No se pudo generar el preview", description: String(err), variant: "error" }),
  });

  const statusMutation = useMutation({
    mutationFn: (status: InterviewPreviewStatus) =>
      apiFetch<InterviewPreviewRecord>(`/candidates/${candidateId}/interview-preview/${jobOrderId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (preview) => {
      queryClient.setQueryData(queryKey, preview);
      toast({ title: `Estado actualizado a ${formatStatusLabel(preview.status)}`, variant: "success" });
    },
    onError: (err) => toast({ title: "Transición de estado inválida", description: String(err), variant: "error" }),
  });

  const neverGenerated = query.isError && isNotFoundError(query.error);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Solo PREVIEW -- nunca se envía una invitación real ni se modifica un calendario.
      </p>

      {canUpdate && (
        <Button size="sm" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending}>
          {generateMutation.isPending ? "Generando…" : query.data ? "Regenerar preview" : "Generar preview de entrevista"}
        </Button>
      )}

      {query.isLoading && <p className="text-muted-foreground">Cargando…</p>}
      {neverGenerated && !query.data && <p className="text-muted-foreground">Todavía no se generó un preview de entrevista.</p>}

      {query.data && (
        <div className="space-y-2">
          <Badge variant={statusVariant(query.data.status)}>{formatStatusLabel(query.data.status)}</Badge>
          <p>Modalidad: {query.data.modality} · Duración: {query.data.durationMinutes} min · TZ: {query.data.timezone}</p>
          <ul className="list-inside list-disc">
            {query.data.proposedWindows.map((w, i) => (
              <li key={i}>
                {new Date(w.start).toLocaleString()} — {new Date(w.end).toLocaleString()}
              </li>
            ))}
          </ul>
          {query.data.conflicts.length > 0 && (
            <p className="text-destructive">{query.data.conflicts.length} conflicto(s) detectado(s) con otro preview del mismo candidato.</p>
          )}
          {query.data.missingInformation.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">Falta: {query.data.missingInformation.join(", ")}</p>
          )}

          {canUpdate && (
            <div className="flex items-end gap-2 border-t border-border pt-2">
              <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value as InterviewPreviewStatus)}>
                {INTERVIEW_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {formatStatusLabel(s)}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="outline" onClick={() => statusMutation.mutate(nextStatus)} disabled={statusMutation.isPending}>
                Cambiar estado
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlacementReadinessSection({ candidateId, jobOrderId, canUpdate }: { candidateId: string; jobOrderId: string; canUpdate: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = ["candidate-placement-readiness", candidateId, jobOrderId];

  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<PlacementReadinessRecord>(`/candidates/${candidateId}/placement-readiness/${jobOrderId}`),
    retry: false,
  });

  const evaluateMutation = useMutation({
    mutationFn: () => apiFetch<PlacementReadinessRecord>(`/candidates/${candidateId}/placement-readiness/${jobOrderId}`, { method: "POST" }),
    onSuccess: (readiness) => {
      queryClient.setQueryData(queryKey, readiness);
      toast({ title: `Readiness: ${formatStatusLabel(readiness.readinessStatus)}`, variant: "success" });
    },
    onError: (err) => toast({ title: "No se pudo evaluar placement readiness", description: String(err), variant: "error" }),
  });

  const neverEvaluated = query.isError && isNotFoundError(query.error);

  return (
    <div className="space-y-3 text-sm">
      {canUpdate && (
        <Button size="sm" onClick={() => evaluateMutation.mutate()} disabled={evaluateMutation.isPending}>
          {evaluateMutation.isPending ? "Evaluando…" : query.data ? "Re-evaluar" : "Evaluar placement readiness"}
        </Button>
      )}

      {query.isLoading && <p className="text-muted-foreground">Cargando…</p>}
      {neverEvaluated && !query.data && <p className="text-muted-foreground">Todavía no se evaluó placement readiness.</p>}

      {query.data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(query.data.readinessStatus)}>{formatStatusLabel(query.data.readinessStatus)}</Badge>
            <span className="text-xs text-muted-foreground">Score {query.data.score}/100</span>
          </div>
          <p className="rounded border border-border bg-muted/40 p-2 text-xs">
            <span className="font-medium">Próxima acción sugerida: </span>
            {query.data.nextBestAction}
          </p>
          {query.data.blockers.length > 0 && (
            <p className="text-destructive">
              <span className="font-medium">Bloqueadores: </span>
              {query.data.blockers.join(" · ")}
            </p>
          )}
          {query.data.warnings.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              <span className="font-medium">Advertencias: </span>
              {query.data.warnings.join(" · ")}
            </p>
          )}
          {query.data.missingInformation.length > 0 && (
            <p className="text-muted-foreground">
              <span className="font-medium">Datos faltantes: </span>
              {query.data.missingInformation.join(" · ")}
            </p>
          )}
          <p className="text-xs italic text-muted-foreground">
            Requiere aprobación humana explícita antes de cualquier acción -- esta pantalla nunca crea un Placement/Assignment ni activa un Worker.
          </p>
        </div>
      )}
    </div>
  );
}

export function CandidatePipelineDrawer({
  candidateId,
  jobOrderId,
  onClose,
}: {
  candidateId: string | null;
  jobOrderId: string;
  onClose: () => void;
}) {
  const { data: currentUser } = useCurrentUser();
  const canUpdate = currentUser?.permissions.includes("candidates.update") ?? false;

  return (
    <Drawer open={!!candidateId} onClose={onClose} title="Pipeline del candidato">
      {candidateId && (
        <div className="space-y-6">
          <Link to={`/candidates/${candidateId}`} className="text-sm text-primary underline underline-offset-2">
            Ver perfil completo del candidato
          </Link>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Calificación</h3>
            <QualificationSection candidateId={candidateId} jobOrderId={jobOrderId} />
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Screening</h3>
            <ScreeningSection candidateId={candidateId} jobOrderId={jobOrderId} canUpdate={canUpdate} />
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Entrevista (preview)</h3>
            <InterviewSection candidateId={candidateId} jobOrderId={jobOrderId} canUpdate={canUpdate} />
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Placement Readiness</h3>
            <PlacementReadinessSection candidateId={candidateId} jobOrderId={jobOrderId} canUpdate={canUpdate} />
          </section>
        </div>
      )}
    </Drawer>
  );
}

