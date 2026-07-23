import { z } from "zod";
import { AGENT_CAPABILITIES, HIGH_RISK_CAPABILITIES } from "./AgentCapability";

/**
 * F25 Fase 1 (ADR-0007): límites operativos por tenant/misión --
 * docs/F25_AUTONOMY_POLICY_MODEL.md §3. Se persiste dentro de
 * `Tenant.settings.policyEnvelope` (Json ya existente, mismo lugar que
 * `aiMonthlyBudgetUsd`/`activeIndustries` hoy) -- nunca una tabla
 * nueva por ahora. Puro schema + validación; NADIE lo enforced todavía
 * (eso es F25.5) -- declarar/persistir un envelope en esta fase no
 * cambia ningún comportamiento productivo.
 */

const sendWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6), // 0=domingo, igual convención que Date.getDay()
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1),
});

export const policyEnvelopeSchema = z.object({
  autonomyLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  dailyEmailLimit: z.number().int().nonnegative(),
  perDomainLimit: z.number().int().nonnegative(),
  allowedIndustries: z.union([z.array(z.string()), z.literal("ALL")]),
  allowedRegions: z.union([z.array(z.string()), z.literal("ALL")]),
  approvedSenderIdentity: z.object({ name: z.string().min(1), email: z.string().email() }).nullable(),
  allowedSendWindows: z.array(sendWindowSchema),
  contactVerificationRequirement: z.enum(["NONE", "ORG_EMAIL", "PERSON_VERIFIED", "CONFIRMED_OR_VERIFIED"]),
  humanApprovalRequirement: z.enum(["ALWAYS", "HIGH_RISK_ONLY", "NEVER"]),
  meetingBookingPermission: z.boolean(),
  replyAutomationPermission: z.boolean(),
  maxLLMCost: z.number().nonnegative(),
  maxDiscoveryCost: z.number().nonnegative(),
  // nonnegative (no positive): 0 es el default seguro real -- "ningún
  // intento de enriquecimiento automático permitido todavía", no un
  // valor inválido.
  maxEnrichmentAttempts: z.number().int().nonnegative(),
  prohibitedActions: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])),
});

export type PolicyEnvelope = z.infer<typeof policyEnvelopeSchema>;

// F25 (ADR-0007, docs/F25_AUTONOMY_POLICY_MODEL.md §3): el default
// seguro -- el que rige hoy de facto sin que nadie configure nada.
// autonomyLevel=1 + humanApprovalRequirement=ALWAYS +
// SEND_EMAIL/BOOK_MEETING prohibidas coincide exactamente con cómo se
// comporta el sistema real hoy (ningún camino de código envía sin
// pasar por decideApproval + sendApproval, F17/F21/F24).
export const DEFAULT_POLICY_ENVELOPE: PolicyEnvelope = {
  autonomyLevel: 1,
  dailyEmailLimit: 0,
  perDomainLimit: 0,
  allowedIndustries: "ALL",
  allowedRegions: "ALL",
  approvedSenderIdentity: null,
  allowedSendWindows: [],
  contactVerificationRequirement: "CONFIRMED_OR_VERIFIED",
  humanApprovalRequirement: "ALWAYS",
  meetingBookingPermission: false,
  replyAutomationPermission: false,
  maxLLMCost: 0,
  maxDiscoveryCost: 0,
  maxEnrichmentAttempts: 0,
  prohibitedActions: [...HIGH_RISK_CAPABILITIES],
};
