import { z } from "zod";
import {
  DEFAULT_MODEL,
  createLeadTool as createLeadToolStub,
  createLeadInputSchema,
  detectHiringSignalsTool as detectHiringSignalsToolStub,
  detectHiringSignalsInputSchema,
  draftOutreachTool as draftOutreachToolStub,
  draftOutreachInputSchema,
  identifyContactsTool as identifyContactsToolStub,
  identifyContactsInputSchema,
  scoreCompanyTool as scoreCompanyToolStub,
  scoreCompanyInputSchema,
  searchCompaniesTool as searchCompaniesToolStub,
  searchCompaniesInputSchema,
  suggestFollowUpTool as suggestFollowUpToolStub,
  suggestFollowUpInputSchema,
  SALES_AGENT_SYSTEM_PROMPT,
  type AgentTool,
  type LLMProvider,
} from "@ai-staffing-os/agents";
import { scopedDb } from "../../../core/tenancy/prisma-extension";
import { getTenancyContext } from "../../../core/tenancy/context";
import { logActivity } from "../../../core/activity-log";
import { AppError } from "../../../core/errors";
import * as leadsService from "../../leads/service";
import type { UsageAccumulator } from "../usage";

const COMPANY_SIZE_ORDER = ["MICRO", "SMALL", "MEDIUM", "LARGE", "ENTERPRISE"] as const;

function sizesAtLeast(min: (typeof COMPANY_SIZE_ORDER)[number]): string[] {
  const idx = COMPANY_SIZE_ORDER.indexOf(min);
  return COMPANY_SIZE_ORDER.slice(idx);
}

function businessDaysFromNow(count: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

async function activeIndustries(): Promise<string[]> {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  const tenant = await scopedDb.tenant.findUnique({ where: { id: ctx.tenantId } });
  const settings = (tenant?.settings ?? {}) as { activeIndustries?: string[] };
  return settings.activeIndustries ?? [];
}

async function auditAgentAction(params: {
  agentInstanceId: string;
  action: string;
  entityType: string;
  entityId: string;
  after?: unknown;
}) {
  const ctx = getTenancyContext();
  if (!ctx) throw AppError.unauthorized();
  await scopedDb.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorType: "AGENT",
      actorId: params.agentInstanceId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      after: params.after as never,
    },
  });
}

/**
 * Parses a JSON object the LLM was asked to return. Never throws on
 * malformed output — callers fall back to a deterministic-only result and
 * label it as such, rather than risk propagating a hallucinated shape.
 */
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

export interface SalesToolDeps {
  taskId: string;
  agentInstanceId: string;
  llmProvider: LLMProvider;
  usage: UsageAccumulator;
}

/**
 * Rebuilds the 7 Sales Agent tools with real execute() implementations,
 * bound to one specific AgentTask. name/description/inputSchema are
 * reused unchanged from packages/agents (single source of truth) —
 * see F2 plan §10: concrete implementations live in apps/api because they
 * need the same services humans use (regla de oro, Arquitectura §3.3).
 */
export function createSalesTools(deps: SalesToolDeps): AgentTool[] {
  return [
    // ---- searchCompanies: deterministic, no LLM ----
    {
      ...searchCompaniesToolStub,
      async execute(input: z.infer<typeof searchCompaniesInputSchema>) {
        const sizes = input.minEstimatedSize ? sizesAtLeast(input.minEstimatedSize) : undefined;
        const companies = await scopedDb.company.findMany({
          where: {
            status: { in: ["LEAD", "PROSPECT"] },
            industryId: input.industryId,
            state: input.state,
            estimatedSize: sizes ? { in: sizes as never } : undefined,
          },
          orderBy: [{ createdAt: "asc" }],
          take: 20,
        });
        return { companyIds: companies.map((c) => c.id) };
      },
    },

    // ---- detectHiringSignals: deterministic, reads internal data only (F2 §5, no scraping) ----
    {
      ...detectHiringSignalsToolStub,
      async execute(input: z.infer<typeof detectHiringSignalsInputSchema>) {
        const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
        if (!company) throw AppError.notFound("Company not found");

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const [similarCompaniesHiring, recentWonOpportunities] = await Promise.all([
          scopedDb.jobOrder.count({
            where: {
              status: { in: ["OPEN", "PARTIALLY_FILLED"] },
              createdAt: { gte: thirtyDaysAgo },
              company: { industryId: company.industryId, id: { not: company.id } },
            },
          }),
          scopedDb.opportunity.count({
            where: {
              stage: "WON",
              updatedAt: { gte: ninetyDaysAgo },
              company: { industryId: company.industryId },
            },
          }),
        ]);

        const signals: string[] = [];
        if (similarCompaniesHiring > 0) {
          signals.push(
            `${similarCompaniesHiring} job order(s) abierto(s) en los últimos 30 días en empresas de la misma industria.`,
          );
        }
        if (recentWonOpportunities > 0) {
          signals.push(`${recentWonOpportunities} oportunidad(es) ganada(s) recientemente en la misma industria.`);
        }
        if (input.manualSignal) {
          signals.push(`Señal manual: ${input.manualSignal}`);
        }

        // Heuristic, not a probability — each independent signal adds 0.3,
        // capped at 1. Documented as approximate (F2 §7's hybrid pattern
        // reserves real probabilistic scoring for scoreCompany).
        const confidence = Math.min(1, signals.length * 0.3);

        return { signals, confidence };
      },
    },

    // ---- identifyContacts: deterministic ----
    {
      ...identifyContactsToolStub,
      async execute(input: z.infer<typeof identifyContactsInputSchema>) {
        const contacts = await scopedDb.contact.findMany({
          where: { companyId: input.companyId, decisionRole: input.decisionRole },
        });
        return { contactIds: contacts.map((c) => c.id) };
      },
    },

    // ---- createLead: deterministic score, reuses leadsService.createLead ----
    {
      ...createLeadToolStub,
      async execute(input: z.infer<typeof createLeadInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        let industryId = input.industryId;
        let city = input.city;
        let state = input.state;

        if (input.companyId) {
          const company = await scopedDb.company.findUnique({ where: { id: input.companyId } });
          if (!company) throw AppError.notFound("Company not found");
          industryId = industryId ?? company.industryId;
          city = city ?? company.city ?? undefined;
          state = state ?? company.state ?? undefined;
        }

        const reasons: string[] = [];
        let score = 5;
        if (input.companyId) {
          score += 2;
          reasons.push("empresa ya identificada en el CRM (no es un lead frío sin destino)");
        }
        if (industryId) {
          const industry = await scopedDb.industry.findUnique({ where: { id: industryId } });
          const active = await activeIndustries();
          if (industry && active.includes(industry.name)) {
            score += 2;
            reasons.push(`industria activa del tenant (${industry.name})`);
          }
        }
        if (input.source === "referral") {
          score += 1;
          reasons.push("fuente de referido (canal históricamente más cálido)");
        } else if (input.source === "cold-outreach") {
          score -= 1;
          reasons.push("fuente de cold-outreach (canal más frío)");
        }
        score = Math.max(0, Math.min(10, score));

        const aiScoreReason =
          reasons.length > 0
            ? `Score ${score}/10 — factores: ${reasons.join("; ")}.`
            : `Score ${score}/10 — sin señales adicionales disponibles.`;

        const lead = await leadsService.createLead({
          companyId: input.companyId,
          industryId,
          city,
          state,
          source: input.source,
          aiScore: score,
          aiScoreReason,
        });

        await scopedDb.lead.update({ where: { id: lead.id }, data: { createdByAgentTaskId: deps.taskId } });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "lead.created_by_agent",
          entityType: "lead",
          entityId: lead.id,
          after: { aiScore: score, aiScoreReason },
        });

        return { leadId: lead.id };
      },
    },

    // ---- scoreCompany: hybrid deterministic + LLM (D8 pattern, F2 §7) ----
    {
      ...scoreCompanyToolStub,
      async execute(input: z.infer<typeof scoreCompanyInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const company = await scopedDb.company.findUnique({
          where: { id: input.companyId },
          include: { industry: true, contacts: true, _count: { select: { opportunities: true } } },
        });
        if (!company) throw AppError.notFound("Company not found");

        const active = await activeIndustries();
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentActivity = await scopedDb.activity.findFirst({
          where: { entityType: "company", entityId: company.id, createdAt: { gte: thirtyDaysAgo } },
        });

        const factors: string[] = [];
        let base = 20;
        if (active.includes(company.industry.name)) {
          base += 30;
          factors.push(`industria activa del tenant (${company.industry.name}): +30`);
        }
        if (company.estimatedSize && ["MEDIUM", "LARGE", "ENTERPRISE"].includes(company.estimatedSize)) {
          base += 15;
          factors.push(`tamaño estimado ${company.estimatedSize}: +15`);
        }
        if (company.contacts.some((c) => c.decisionRole)) {
          base += 15;
          factors.push("tiene contacto con rol de decisión identificado: +15");
        }
        if (recentActivity) {
          base += 10;
          factors.push("actividad reciente (últimos 30 días): +10");
        }
        if (company._count.opportunities > 0) {
          base += 10;
          factors.push("tiene oportunidad(es) abierta(s): +10");
        }
        base = Math.max(0, Math.min(100, base));

        const prompt = `Empresa: ${company.name}
Industria: ${company.industry.name}
Ubicación: ${company.city ?? "—"}, ${company.state ?? "—"}
Tamaño estimado: ${company.estimatedSize ?? "desconocido"}
Score base calculado (0-100): ${base}
Factores considerados: ${factors.length ? factors.join("; ") : "ninguno — empresa sin señales fuertes todavía"}

Responde ÚNICAMENTE con un JSON de la forma {"adjustment": <número entre -10 y 10>, "rationale": "<2-3 frases en español explicando el potencial comercial de esta empresa, basadas solo en los factores de arriba>"}. No inventes datos que no estén listados arriba.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: SALES_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const parsed = tryParseJson(
          completion.content,
          z.object({ adjustment: z.number().min(-10).max(10), rationale: z.string().min(1) }),
        );

        const finalScore = Math.max(0, Math.min(100, base + (parsed?.adjustment ?? 0)));
        const rationale =
          parsed?.rationale ??
          `Score ${finalScore}/100 (cálculo determinístico, el modelo no devolvió una explicación válida). Factores: ${
            factors.length ? factors.join("; ") : "ninguno"
          }.`;

        const previousScore = company.commercialScore;
        await scopedDb.company.update({
          where: { id: company.id },
          data: { commercialScore: finalScore, commercialScoreReason: rationale },
        });

        await logActivity({
          entityType: "company",
          entityId: company.id,
          type: "SYSTEM",
          subject: `Score comercial actualizado por Sales Agent: ${previousScore ?? "—"} → ${finalScore}`,
        });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "company.scored_by_agent",
          entityType: "company",
          entityId: company.id,
          after: { score: finalScore, rationale },
        });

        return { score: finalScore, rationale };
      },
    },

    // ---- draftOutreach: LLM, always ends in an ApprovalRequest — never sends anything ----
    {
      ...draftOutreachToolStub,
      async execute(input: z.infer<typeof draftOutreachInputSchema>) {
        const ctx = getTenancyContext();
        if (!ctx) throw AppError.unauthorized();

        const lead = await scopedDb.lead.findUnique({
          where: { id: input.leadId },
          include: { company: { include: { contacts: true } }, industry: true },
        });
        if (!lead) throw AppError.notFound("Lead not found");

        const contact =
          lead.company?.contacts.find((c) => c.isPrimary) ??
          lead.company?.contacts.find((c) => c.decisionRole) ??
          lead.company?.contacts[0];

        const prompt = `Redacta un borrador de primer contacto por ${input.channel} para este lead. Es SOLO un borrador — nunca digas que ya fue enviado.

Empresa: ${lead.company?.name ?? "Empresa sin identificar"}
Industria: ${lead.industry?.name ?? lead.company?.industryId ?? "—"}
Ubicación: ${lead.city ?? "—"}, ${lead.state ?? "—"}
Contacto: ${contact ? `${contact.firstName} ${contact.lastName}${contact.title ? `, ${contact.title}` : ""}` : "sin contacto identificado todavía — dirígete a la empresa en general"}
Por qué es una buena oportunidad: ${lead.aiScoreReason ?? "sin score todavía"}

Responde ÚNICAMENTE con un JSON de la forma {${input.channel === "EMAIL" ? '"subject": "<asunto corto>", ' : ""}"body": "<mensaje breve, profesional, sin prometer precios ni compromisos>"}.`;

        const completion = await deps.llmProvider.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: SALES_AGENT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        });
        deps.usage.record(completion);

        const outputSchema =
          input.channel === "EMAIL"
            ? z.object({ subject: z.string().min(1), body: z.string().min(1) })
            : z.object({ body: z.string().min(1) });
        const parsed = tryParseJson(completion.content, outputSchema);

        if (!parsed) {
          throw AppError.internal("El Sales Agent no pudo generar un borrador válido. Intenta de nuevo.");
        }

        const proposedAction = {
          channel: input.channel,
          leadId: lead.id,
          contactId: contact?.id ?? null,
          subject: "subject" in parsed ? parsed.subject : undefined,
          body: parsed.body,
        };

        await scopedDb.approvalRequest.create({
          data: {
            tenantId: ctx.tenantId,
            agentTaskId: deps.taskId,
            summary: `Borrador de ${input.channel === "EMAIL" ? "email" : "LinkedIn"} para ${lead.company?.name ?? "lead sin empresa"}`,
            proposedAction,
            riskLevel: "MEDIUM",
          },
        });
        await auditAgentAction({
          agentInstanceId: deps.agentInstanceId,
          action: "outreach.drafted_by_agent",
          entityType: "lead",
          entityId: lead.id,
          after: proposedAction,
        });

        return { draftBody: parsed.body };
      },
    },

    // ---- suggestFollowUp: deterministic, proposes only — never creates the FollowUp ----
    {
      ...suggestFollowUpToolStub,
      async execute(input: z.infer<typeof suggestFollowUpInputSchema>) {
        const lastActivity = await scopedDb.activity.findFirst({
          where: { entityType: input.entityType, entityId: input.entityId },
          orderBy: { createdAt: "desc" },
        });

        if (!lastActivity) {
          return {
            suggestedDueDate: businessDaysFromNow(2).toISOString(),
            suggestedType: "CALL",
            reason: "Sin actividad registrada todavía — se recomienda un primer contacto por llamada.",
          };
        }

        const daysSince = Math.floor((Date.now() - lastActivity.createdAt.getTime()) / (24 * 60 * 60 * 1000));
        if (daysSince > 14) {
          return {
            suggestedDueDate: businessDaysFromNow(1).toISOString(),
            suggestedType: "CALL",
            reason: `Han pasado ${daysSince} días desde la última actividad — se recomienda retomar contacto pronto.`,
          };
        }

        return {
          suggestedDueDate: businessDaysFromNow(5).toISOString(),
          suggestedType: "EMAIL",
          reason: "Seguimiento de rutina — última actividad reciente.",
        };
      },
    },
  ];
}
