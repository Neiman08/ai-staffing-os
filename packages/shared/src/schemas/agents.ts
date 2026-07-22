import { z } from "zod";
import { companySizeSchema, contactDecisionRoleSchema } from "./crm";

export const agentInstanceListItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  autonomyLevel: z.string(),
  isActive: z.boolean(),
  metrics: z.record(z.string(), z.unknown()),
});
export type AgentInstanceListItem = z.infer<typeof agentInstanceListItemSchema>;

// ============================================================
// F2: AgentTask invocation, status and approvals
// ============================================================

export const agentTaskStatusSchema = z.enum(["QUEUED", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED"]);
export type AgentTaskStatusValue = z.infer<typeof agentTaskStatusSchema>;

export const taskTriggerSchema = z.enum(["USER", "EVENT", "AGENT", "SCHEDULE"]);

// The 7 real Sales Agent tools (F2 §3). `type` on AgentTask/invocation
// maps 1:1 to a tool name in packages/agents/src/tools/sales-tools.ts.
export const agentTaskTypeSchema = z.enum([
  "search_companies",
  "detect_hiring_signals",
  "identify_contacts",
  "create_lead",
  "score_company",
  "draft_outreach",
  "suggest_follow_up",
  "create_opportunity", // F3
  "create_follow_up", // F3
]);
export type AgentTaskType = z.infer<typeof agentTaskTypeSchema>;

export const invokeSalesAgentInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search_companies"),
    input: z.object({
      industryId: z.string().optional(),
      state: z.string().optional(),
      minEstimatedSize: companySizeSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("detect_hiring_signals"),
    input: z.object({
      companyId: z.string(),
      manualSignal: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("identify_contacts"),
    input: z.object({
      companyId: z.string(),
      decisionRole: contactDecisionRoleSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("create_lead"),
    input: z.object({
      companyId: z.string().optional(),
      industryId: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      source: z.string(),
    }),
  }),
  z.object({
    type: z.literal("score_company"),
    input: z.object({ companyId: z.string() }),
  }),
  z.object({
    type: z.literal("draft_outreach"),
    input: z.object({
      leadId: z.string(),
      channel: z.enum(["EMAIL", "LINKEDIN"]),
    }),
  }),
  z.object({
    type: z.literal("suggest_follow_up"),
    input: z.object({
      entityType: z.enum(["company", "lead", "opportunity", "contact"]),
      entityId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("create_opportunity"),
    input: z.object({ leadId: z.string() }),
  }),
  z.object({
    type: z.literal("create_follow_up"),
    input: z.object({
      entityType: z.enum(["company", "lead", "opportunity", "contact"]),
      entityId: z.string(),
    }),
  }),
]);
export type InvokeSalesAgentInput = z.infer<typeof invokeSalesAgentInputSchema>;

export const agentTaskQuerySchema = z.object({
  agentInstanceId: z.string().optional(),
  status: agentTaskStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type AgentTaskQuery = z.infer<typeof agentTaskQuerySchema>;

export const agentTaskListItemSchema = z.object({
  id: z.string(),
  agentInstanceId: z.string(),
  agentKey: z.string(),
  type: z.string(),
  status: agentTaskStatusSchema,
  triggeredBy: taskTriggerSchema,
  tokensUsed: z.number().nullable(),
  costUsd: z.string().nullable(),
  errorMessage: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type AgentTaskListItem = z.infer<typeof agentTaskListItemSchema>;

export const agentTaskDetailSchema = agentTaskListItemSchema.extend({
  input: z.unknown(),
  output: z.unknown().nullable(),
  approvalRequestId: z.string().nullable(),
});
export type AgentTaskDetail = z.infer<typeof agentTaskDetailSchema>;

// ============================================================
// F2: Approvals — every draftOutreach ends in one of these (F2 §9)
// ============================================================

// F21 Fase 4: READY_TO_SEND/SENDING/SENT/FAILED agregados -- separación
// aprobación/envío. PENDING/APPROVED/REJECTED/EXPIRED nunca cambian de
// significado (compatibilidad con filas históricas) -- una fila APPROVED
// de antes de este cambio ya fue enviada bajo el comportamiento viejo.
// Desde este cambio, una decisión APPROVED transiciona directo a
// READY_TO_SEND, nunca queda descansando en APPROVED.
export const approvalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "READY_TO_SEND", "SENDING", "SENT", "FAILED"]);
export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

// F17: presente SOLO en la respuesta directa de decideApproval (nunca en
// listApprovals) -- feedback inmediato de si el envío real vía
// Microsoft Graph funcionó. `null` = no era un borrador de email (ej.
// LinkedIn, o la decisión fue REJECTED). Ver modules/email/email-service.ts.
export const approvalEmailSendResultSchema = z
  .object({
    status: z.enum(["SENT", "FAILED", "RETRYABLE"]),
    providerMessageId: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .nullable();
export type ApprovalEmailSendResult = z.infer<typeof approvalEmailSendResultSchema>;

export const approvalRequestListItemSchema = z.object({
  id: z.string(),
  agentTaskId: z.string(),
  agentTaskType: z.string(),
  summary: z.string(),
  proposedAction: z.unknown(),
  riskLevel: riskLevelSchema,
  status: approvalStatusSchema,
  decidedByLabel: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  // F21 Fase 4: quién/cuándo ejecutó la acción de ENVÍO real (sendApproval)
  // -- siempre distinto de decidedByLabel/decidedAt (la aprobación).
  sentByLabel: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  emailSendResult: approvalEmailSendResultSchema.optional(),
});
export type ApprovalRequestListItem = z.infer<typeof approvalRequestListItemSchema>;

export const decideApprovalInputSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalInputSchema>;

// F17: envío manual real desde el CRM -- "correos manuales enviados
// desde el CRM" del pedido real. SIEMPRE sale del perfil COMMERCIAL
// (sales@<dominio>, ver modules/email/sender-profiles.ts) -- este
// endpoint nunca acepta un `from`/perfil de texto libre, mismo criterio
// que el resto del envío real. Vínculos opcionales para asociar el
// envío a un Lead/Opportunity/Company real cuando corresponda.
export const sendManualEmailInputSchema = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  leadId: z.string().optional(),
  opportunityId: z.string().optional(),
  companyId: z.string().optional(),
  contactId: z.string().optional(),
});
export type SendManualEmailInput = z.infer<typeof sendManualEmailInputSchema>;

export const sendManualEmailResultSchema = z.object({
  emailMessageId: z.string(),
  status: z.enum(["SENT", "FAILED", "RETRYABLE"]),
  providerMessageId: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type SendManualEmailResult = z.infer<typeof sendManualEmailResultSchema>;
