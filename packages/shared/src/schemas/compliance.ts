import { z } from "zod";

export const documentListItemSchema = z.object({
  id: z.string(),
  documentTypeName: z.string(),
  ownerLabel: z.string(),
  ownerType: z.enum(["candidate", "worker"]),
  status: z.string(),
  issuedDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  verifiedByAgent: z.boolean(),
});
export type DocumentListItem = z.infer<typeof documentListItemSchema>;

export const complianceAlertListItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  message: z.string(),
  workerName: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ComplianceAlertListItem = z.infer<typeof complianceAlertListItemSchema>;

export const documentTypeListItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  category: z.string(),
  requiresExpiration: z.boolean(),
});
export type DocumentTypeListItem = z.infer<typeof documentTypeListItemSchema>;

// F5.5: enum real (packages/db/prisma/schema.prisma DocumentStatus) — no
// se amplía. EXPIRING no es un status de Document (es un tipo de
// ComplianceAlertType) — un documento vencido pasa a EXPIRED directamente.
export const documentStatusSchema = z.enum(["PENDING_REVIEW", "VERIFIED", "REJECTED", "EXPIRED"]);
export type DocumentStatusValue = z.infer<typeof documentStatusSchema>;

/**
 * F5.5 (plan §7.3, aprobado): storage real de archivos sigue diferido
 * (P2 de DECISION_LOG.md, sin resolver desde F0) — se acepta `fileUrl`
 * como una URL ya alojada externamente, nunca se construye upload real
 * acá. Exactamente uno de candidateId/workerId debe proveerse (dueño
 * polimórfico-manual, mismo patrón que el propio modelo Document).
 */
export const createDocumentInputSchema = z
  .object({
    documentTypeId: z.string().min(1),
    candidateId: z.string().optional(),
    workerId: z.string().optional(),
    fileUrl: z.string().optional(),
    issuedDate: z.string().optional(),
    expirationDate: z.string().optional(),
  })
  .refine((v) => !!v.candidateId !== !!v.workerId, {
    message: "Exactly one of candidateId or workerId must be provided",
    path: ["candidateId"],
  });
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

// F5.5: rejectionReason obligatorio cuando status=REJECTED (validado en
// el servicio, no acá — Zod no puede expresar "requerido según el valor
// de otro campo" de forma legible sin un refine ad-hoc; se prefiere el
// error de negocio explícito del servicio, mismo criterio que
// JobOrder/Candidate ya aplicaron a validaciones cruzadas).
export const verifyDocumentInputSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});
export type VerifyDocumentInput = z.infer<typeof verifyDocumentInputSchema>;

// F5.5: sin body — resolver una alerta es una acción binaria (resolvedAt/
// resolvedById desde el contexto), no requiere ningún campo del cliente.
export const resolveComplianceAlertInputSchema = z.object({});
export type ResolveComplianceAlertInput = z.infer<typeof resolveComplianceAlertInputSchema>;
