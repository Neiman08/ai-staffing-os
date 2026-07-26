import { z } from "zod";

/**
 * F27 (Internal Acceptance Test): la ÚNICA forma oficial de probar el
 * flujo real de Approve & Send de punta a punta sin usar un prospecto
 * real -- ver apps/api/src/modules/internal-testing/service.ts. `acceptanceTest`
 * es un literal (no un boolean cualquiera) a propósito: la solicitud debe
 * declarar explícitamente la intención, nunca un default silencioso.
 */
export const runInternalAcceptanceTestInputSchema = z.object({
  recipientEmail: z.string().email(),
  acceptanceTest: z.literal(true),
  reason: z.string().min(1),
});
export type RunInternalAcceptanceTestInput = z.infer<typeof runInternalAcceptanceTestInputSchema>;

export const internalAcceptanceTestResultSchema = z.object({
  companyId: z.string(),
  leadId: z.string(),
  contactId: z.string(),
  approvalRequestId: z.string(),
  emailMessageId: z.string().nullable(),
  correlationId: z.string().nullable(),
  approvalStatus: z.string(),
  emailSendResult: z
    .object({
      status: z.string(),
      providerMessageId: z.string().nullable(),
      internetMessageId: z.string().nullable().optional(),
      conversationId: z.string().nullable().optional(),
      errorMessage: z.string().nullable(),
    })
    .nullable(),
  initiatedAt: z.string(),
  completedAt: z.string(),
});
export type InternalAcceptanceTestResult = z.infer<typeof internalAcceptanceTestResultSchema>;
