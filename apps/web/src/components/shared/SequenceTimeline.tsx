import { CheckCircle2, CircleDashed, Mail, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SequenceStepItem {
  id: string;
  status: string;
  dueDate: string;
  notes: string | null;
}

const STEP_LABELS = ["Día 1 — Primer contacto", "Día 4 — Seguimiento", "Día 9 — Caso de éxito", "Día 18 — Último intento"];

function StepIcon({ status }: { status: string }) {
  if (status === "DONE") return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === "CANCELLED") return <XCircle className="h-5 w-5 text-muted-foreground/50" />;
  return <CircleDashed className="h-5 w-5 text-amber-500" />;
}

/** F4 §14: visualiza la secuencia día 1/4/9/18 — "todo queda preparado" hecho visible. */
export function SequenceTimeline({ steps }: { steps: SequenceStepItem[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin secuencia planificada todavía.</p>;
  }

  return (
    <div className="space-y-3">
      {steps.map((step, i) => (
        <div
          key={step.id}
          className={cn(
            "flex items-start gap-3 rounded-lg border border-border p-3",
            step.status === "CANCELLED" && "opacity-60",
          )}
        >
          <StepIcon status={step.status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{STEP_LABELS[i] ?? `Paso ${i + 1}`}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(step.dueDate).toLocaleDateString()}
              </span>
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Mail className="h-3 w-3 shrink-0" />
              {step.status === "DONE"
                ? "Borrador preparado"
                : step.status === "CANCELLED"
                  ? "Cancelado (se detuvo la secuencia tras una respuesta)"
                  : "Pendiente"}
              {step.notes ? ` — ${step.notes}` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
