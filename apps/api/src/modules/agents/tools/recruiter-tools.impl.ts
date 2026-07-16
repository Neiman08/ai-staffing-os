import { z } from "zod";
import {
  DEFAULT_MODEL,
  matchWorkersToJobOrderTool as matchWorkersToJobOrderToolStub,
  matchWorkersToJobOrderInputSchema,
  RECRUITER_AGENT_SYSTEM_PROMPT,
  type AgentTool,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import type { MatchRunResult, WorkerMatchResult } from "@ai-staffing-os/shared";
import { getTenancyContext } from "../../../core/tenancy/context";
import { AppError } from "../../../core/errors";
import { getMonthlyBudgetStatus } from "../budget";
import { runDeterministicMatching } from "../../matching/service";
import type { UsageAccumulator } from "../usage";

function tryParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed: unknown = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return schema.parse(parsed);
  } catch {
    return null;
  }
}

// F6.5 (plan §7.5, obligatorio): el prompt de revisión LLM recibe
// ÚNICAMENTE factores ya derivados (números/categorías) — nunca
// displayName, ciudad cruda, ni ningún dato de Candidate/Document sin
// resumir. Esto es deliberado, no un descuido: mitiga cualquier sesgo
// asociado a nombres/ubicación exacta que un modelo pudiera inferir.
//
// Importante: NO se reenvían worker.strengths/worker.gaps tal cual —
// esos arrays (pensados para la UI humana de F6.7) incluyen
// factor.evidence[0], que para el factor "ubicación" contiene la
// ciudad cruda del candidato (ej. "Misma ciudad (Chicago)."). El
// resumen para el LLM se reconstruye acá solo con label+score de cada
// factor, nunca con evidence.
function summarizeFactorsForPrompt(worker: WorkerMatchResult): { strong: string[]; weak: string[] } {
  const strong: string[] = [];
  const weak: string[] = [];
  for (const factor of Object.values(worker.factors)) {
    const ratio = factor.score / factor.maxWeight;
    if (ratio >= 0.8) strong.push(factor.label);
    else if (ratio <= 0.3) weak.push(factor.label);
  }
  return { strong, weak };
}

function buildWorkerReviewPrompt(worker: WorkerMatchResult, jobOrder: MatchRunResult["inputSnapshot"]): string {
  const factorLines = Object.values(worker.factors)
    .map((f) => `- ${f.label}: ${f.score.toFixed(1)}/${f.maxWeight}`)
    .join("\n");
  const { strong, weak } = summarizeFactorsForPrompt(worker);

  return `Job Order: categoría ${jobOrder.categoryId}, payRate ${jobOrder.payRate}, requiere ${jobOrder.requirements.length} documento(s).

Worker (id ${worker.workerId}) — score determinista: ${worker.deterministicScore.toFixed(1)}/100.
Factores:
${factorLines}

Evaluación de compliance: ${worker.complianceAssessment.label}.
Evaluación de disponibilidad: ${worker.availabilityAssessment.label}.
Factores fuertes: ${strong.length > 0 ? strong.join(", ") : "ninguno destacado"}.
Factores débiles: ${weak.length > 0 ? weak.join(", ") : "ninguno"}.

Responde ÚNICAMENTE con un JSON de la forma {"adjustment": <número entre -10 y 10>, "rationale": "<1-2 frases en español explicando el ajuste, basadas solo en los factores de arriba>"}. Si no hay razón para ajustar, usa adjustment: 0. No inventes datos que no estén listados arriba.`;
}

const llmReviewResponseSchema = z.object({ adjustment: z.number().min(-10).max(10), rationale: z.string().min(1) });

export interface RecruiterToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * Revisa con LLM cada Worker ya elegible (nunca los no-elegibles — los
 * filtros de F6.3 ya los excluyeron antes de llegar acá, estructuralmente
 * imposible que el LLM los vea). Un error de red/proveedor en cualquier
 * llamada detiene el resto de la revisión de inmediato (llmStatus=
 * "FAILED", se conserva el resto en su score determinista); una
 * respuesta que no parsea a JSON válido se trata individualmente
 * (ese Worker se queda en su score determinista, se sigue con los
 * demás — llmStatus="FALLBACK_DETERMINISTIC" si ocurrió al menos una vez).
 */
async function reviewEligibleWorkersWithLlm(
  deps: RecruiterToolDeps,
  deterministic: MatchRunResult,
): Promise<{ eligibleWorkers: WorkerMatchResult[]; llmStatus: MatchRunResult["llmStatus"] }> {
  if (deterministic.eligibleWorkers.length === 0) {
    return { eligibleWorkers: [], llmStatus: "COMPLETED" };
  }

  const reviewed: WorkerMatchResult[] = [];
  let sawParseFailure = false;

  for (let i = 0; i < deterministic.eligibleWorkers.length; i++) {
    const worker = deterministic.eligibleWorkers[i]!;
    let completion;
    try {
      completion = await deps.llmProvider.complete({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system", content: RECRUITER_AGENT_SYSTEM_PROMPT },
          { role: "user", content: buildWorkerReviewPrompt(worker, deterministic.inputSnapshot) },
        ],
      });
    } catch {
      // Error duro del proveedor (red/timeout) — detener la revisión de
      // inmediato en vez de seguir gastando presupuesto en más llamadas
      // que probablemente también fallarían. Este Worker y todo el resto
      // sin revisar conservan su score determinista sin tocar.
      reviewed.push(...deterministic.eligibleWorkers.slice(i));
      return { eligibleWorkers: reviewed, llmStatus: "FAILED" };
    }
    deps.usage.record(completion);

    const parsed = tryParseJson(completion.content, llmReviewResponseSchema);
    if (!parsed) {
      sawParseFailure = true;
      reviewed.push(worker);
      continue;
    }

    const finalScore = Math.max(0, Math.min(100, worker.deterministicScore + parsed.adjustment));
    reviewed.push({
      ...worker,
      llmAdjustment: parsed.adjustment,
      finalScore,
      rationale: parsed.rationale,
    });
  }

  return { eligibleWorkers: reviewed, llmStatus: sawParseFailure ? "FALLBACK_DETERMINISTIC" : "COMPLETED" };
}

export function createRecruiterTools(deps: RecruiterToolDeps): AgentTool[] {
  return [
    {
      ...matchWorkersToJobOrderToolStub,
      async execute(input: z.infer<typeof matchWorkersToJobOrderInputSchema>): Promise<MatchRunResult> {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const deterministic = await runDeterministicMatching(input.jobOrderId);
        const base: MatchRunResult = { ...deterministic, agentTaskId: deps.taskId };

        const withLlm = input.withLlm ?? true;
        if (!withLlm) {
          return { ...base, llmStatus: "NOT_RUN", deterministicOnly: true };
        }

        const budget = await getMonthlyBudgetStatus(ctx.tenantId);
        if (budget.exceeded) {
          return {
            ...base,
            llmStatus: "BUDGET_BLOCKED",
            deterministicOnly: true,
            warnings: [
              ...base.warnings,
              `Presupuesto mensual de IA excedido ($${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)}) — se devuelve el ranking determinista sin revisión de IA.`,
            ],
          };
        }

        const { eligibleWorkers, llmStatus } = await reviewEligibleWorkersWithLlm(deps, base);
        // El ajuste LLM puede reordenar el ranking — se reordena por
        // finalScore desc con el mismo desempate estable por workerId
        // ya usado en el determinista puro (matching/service.ts).
        const sorted = [...eligibleWorkers].sort((a, b) => b.finalScore - a.finalScore || a.workerId.localeCompare(b.workerId));

        return {
          ...base,
          eligibleWorkers: sorted,
          llmStatus,
          deterministicOnly: false,
          provider: "openai",
          model: DEFAULT_MODEL,
          cost: { usd: deps.usage.costUsd },
        };
      },
    },
  ];
}
