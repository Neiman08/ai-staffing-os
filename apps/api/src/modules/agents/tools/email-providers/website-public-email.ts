import { runWebsiteIntelligence } from "../website-intelligence/crawler";
import type { EmailProviderSearchParams, EmailProviderSearchResult } from "./types";
import { emptyEmailResult } from "./types";

/**
 * F4.7 §2.1: fuente #1 de email discovery — envuelve Website Intelligence
 * (gratis, sin API key) con el mismo contrato que un proveedor pago. Un
 * email encontrado acá ya viene con procedencia máxima (la propia
 * empresa lo publicó en su sitio), pero igual pasa por verificación
 * (email-verification-providers/) antes de quedar VERIFIED — un email
 * publicado puede estar desactualizado.
 */
export async function searchWebsitePublicEmail(params: EmailProviderSearchParams): Promise<EmailProviderSearchResult> {
  if (!params.companyWebsite) return emptyEmailResult();

  const result = await runWebsiteIntelligence({
    taskId: params.taskId,
    website: params.companyWebsite,
    abortSignal: params.abortSignal,
  });

  if (result.cancelled) return { ...emptyEmailResult(), cancelled: true };

  const candidates: EmailProviderSearchResult["candidates"] = [];
  for (const person of result.namedPeople) {
    if (person.email) {
      candidates.push({
        firstName: person.firstName,
        lastName: person.lastName,
        title: person.title,
        email: person.email,
        confidenceScore: 0.9, // alto: nombre+cargo+email en el mismo bloque del propio sitio
        sourceUrl: person.sourceUrl,
      });
    }
  }
  for (const generic of result.genericEmails) {
    // Evita duplicar un email que ya se reportó como parte de una
    // tarjeta de persona.
    if (!candidates.some((c) => c.email === generic.email)) {
      candidates.push({
        firstName: null,
        lastName: null,
        title: null,
        email: generic.email,
        confidenceScore: 0.6, // más bajo: sin nombre asociado, podría ser un email compartido/genérico
        sourceUrl: generic.sourceUrl,
      });
    }
  }

  return {
    candidates: candidates.slice(0, params.limit),
    costUsd: 0,
    sourcesUsed: candidates.length > 0 ? [`Website (${params.companyWebsite})`] : [],
    patternsFailed: result.patternsFailed,
    cancelled: false,
  };
}
