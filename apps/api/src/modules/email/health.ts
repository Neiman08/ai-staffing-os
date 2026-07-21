import { env } from "../../core/env";
import { checkMicrosoftGraphHealth } from "./microsoft-graph";
import { resolveSender } from "./sender-profiles";

/**
 * F17 (pedido explícito: "una validación de configuración al arranque y
 * una comprobación de salud del proveedor sin enviar correos"). El
 * arranque en sí ya falla rápido en core/env.ts si la configuración de
 * Microsoft Graph es parcial o si MAIL_FROM es de un dominio ajeno --
 * esta función es la pieza que falta: confirma que las credenciales
 * REALMENTE autentican contra Azure AD (pide un token real), sin tocar
 * ningún mailbox ni crear/enviar ningún mensaje.
 */
export interface EmailProviderHealth {
  configured: boolean;
  healthy: boolean;
  reason: string | null;
  commercialSenderResolved: boolean;
}

export async function getEmailProviderHealth(): Promise<EmailProviderHealth> {
  const configured = !!(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);
  const commercialSenderResolved = !!resolveSender("commercial");

  if (!configured) {
    return { configured: false, healthy: false, reason: "AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET no configuradas", commercialSenderResolved };
  }

  const result = await checkMicrosoftGraphHealth({
    tenantId: env.AZURE_TENANT_ID!,
    clientId: env.AZURE_CLIENT_ID!,
    clientSecret: env.AZURE_CLIENT_SECRET!,
  });

  return { configured: true, healthy: result.healthy, reason: result.reason, commercialSenderResolved };
}
