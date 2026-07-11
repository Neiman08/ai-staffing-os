/**
 * F4.7 §3: contrato compartido entre proveedores de verificación de
 * email. Vocabulario cerrado — mismo espíritu que
 * ContactVerificationStatus/CompanyVerificationStatus, ver schema.prisma
 * EmailVerificationStatus. Solo VERIFIED puede quedar disponible para
 * outreach real (enforced en código en contact-intelligence-tools.impl.ts
 * y de nuevo en el guardia de envío de una fase futura — nunca solo en
 * la UI).
 */
export type EmailVerificationOutcome = "VERIFIED" | "RISKY" | "INVALID" | "UNKNOWN";

export interface EmailVerificationResult {
  status: EmailVerificationOutcome;
  confidenceScore: number | null; // 0–1, del proveedor
  provider: string;
  costUsd: number;
  cancelled: boolean;
  error: string | null; // motivo real si no se pudo verificar (queda UNKNOWN)
}

export interface EmailVerificationParams {
  taskId: string;
  email: string;
  abortSignal?: AbortSignal;
}

export function unknownVerificationResult(provider: string, error: string | null = null): EmailVerificationResult {
  return { status: "UNKNOWN", confidenceScore: null, provider, costUsd: 0, cancelled: false, error };
}
