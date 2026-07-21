import { env } from "../../core/env";

/**
 * F17 (regla de negocio explícita del pedido real): "La configuración
 * comercial debe usar explícitamente sales@dreistaff.com" y "Valida que
 * MAIL_FROM no permita remitentes arbitrarios" -- este archivo es la
 * ÚNICA fuente de verdad de qué dirección/nombre puede usarse como
 * remitente real. Ningún llamador de email-service.ts puede pasar un
 * `from` de texto libre -- solo puede pedir un `EmailSenderProfile`
 * (`"commercial" | "general"`), y este módulo resuelve la dirección
 * real. Así, un bug/typo en código que llame a este servicio nunca
 * puede terminar enviando "desde" una dirección arbitraria: en el peor
 * caso, pide un perfil que no existe (error de tipos en compilación) o
 * un perfil sin configurar (falla explícita, nunca un fallback
 * silencioso a otro remitente).
 *
 * hello@<dominio> (contacto general/institucional) está deliberadamente
 * FUERA de este archivo como perfil propio -- MAIL_FROM cubre ese caso
 * como remitente GENERAL, configurable por env pero siempre validado
 * contra BUSINESS_DOMAIN (ver core/env.ts). sales@<dominio> nunca lee
 * MAIL_FROM ni ninguna otra env var -- está fijo en código a propósito,
 * exactamente como pidió el PO, para que ningún cambio de configuración
 * pueda desviar el correo comercial a otra dirección sin un cambio de
 * código explícito y revisado.
 */

export type EmailSenderProfile = "commercial" | "general";

// F17: RECRUITING queda documentado acá (mismo dominio, mismo criterio
// que "commercial") pero deliberadamente NUNCA se agrega a
// EmailSenderProfile ni a SENDER_PROFILES -- el pedido real fue
// explícito: "No actives todavía envíos automáticos a candidatos". El
// día que se active, agregar "recruiting" a EmailSenderProfile y su
// entrada acá es el único cambio necesario en este archivo; el resto
// del sistema (microsoft-graph.ts/email-service.ts) ya es agnóstico al
// perfil.
export const RESERVED_RECRUITING_SENDER = {
  email: `recruiting@${env.BUSINESS_DOMAIN}`,
  name: "DreiStaff Recruiting",
} as const;

export interface ResolvedSender {
  email: string;
  name: string;
}

function resolveCommercialSender(): ResolvedSender {
  // Fijo en código, nunca leído de env -- ver comentario del archivo.
  return { email: `sales@${env.BUSINESS_DOMAIN}`, name: "DreiStaff Sales" };
}

function resolveGeneralSender(): ResolvedSender | null {
  if (!env.MAIL_FROM) return null;
  // env.ts ya validó que MAIL_FROM termina en "@" + BUSINESS_DOMAIN al
  // arrancar -- este chequeo se repite acá, barato, como defensa en
  // profundidad (nunca confiar ciegamente en que nada mutó env en
  // runtime, mismo criterio que el resto del repo).
  if (!env.MAIL_FROM.toLowerCase().endsWith(`@${env.BUSINESS_DOMAIN.toLowerCase()}`)) return null;
  return { email: env.MAIL_FROM, name: env.OUTREACH_FROM_NAME };
}

/**
 * Resuelve el remitente real para un perfil -- nunca acepta ni devuelve
 * un `from` que no sea exactamente uno de estos dos. `null` significa
 * "perfil válido pero sin configurar todavía" (ej. GENERAL sin
 * MAIL_FROM) -- el llamador debe tratarlo como una falla real, nunca
 * caer a otro remitente en silencio.
 */
export function resolveSender(profile: EmailSenderProfile): ResolvedSender | null {
  if (profile === "commercial") return resolveCommercialSender();
  if (profile === "general") return resolveGeneralSender();
  // Nunca alcanzable con el tipo EmailSenderProfile actual -- guardia
  // explícita igual, para que un cambio futuro del tipo no compile en
  // silencio sin actualizar este switch.
  const exhaustive: never = profile;
  throw new Error(`Unknown email sender profile: ${String(exhaustive)}`);
}

/**
 * Reply-To para un perfil -- mismo criterio que el remitente: comercial
 * siempre responde a sales@, nunca a otra dirección (pedido explícito:
 * "El Reply-To también debe ser sales@dreistaff.com").
 */
export function resolveReplyTo(profile: EmailSenderProfile): string | null {
  if (profile === "commercial") return resolveCommercialSender().email;
  if (profile === "general") return env.OUTREACH_REPLY_TO || resolveGeneralSender()?.email || null;
  return null;
}
