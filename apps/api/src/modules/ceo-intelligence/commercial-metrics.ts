/**
 * F34 (auditoría arquitectónica transversal, 2026-08-05): métricas
 * comerciales reales pedidas explícitamente por la auditoría -- puro y
 * determinista, sin Prisma/fetch/LLM. Cada tasa es una simple división
 * de conteos YA calculados por el llamador (mission-executor.ts/
 * mission-orchestrator.ts) -- este módulo nunca decide qué cuenta como
 * "aceptado"/"válido", solo agrega lo que ya se decidió en otro lado.
 *
 * Invariante explícita (pedida por el usuario): "No inventes aperturas
 * ni respuestas si el proveedor no las suministra" -- reply/meeting
 * (y cualquier métrica de envío real: sent/delivered/hardBounce/
 * spamBlocked) son inputs OPCIONALES (`number | null`). `null` significa
 * "sin dato real disponible en esta capa" -- el resultado para esa
 * métrica es `null` también, NUNCA 0 (0 afirmaría "hubo cero respuestas
 * reales medidas", que es una afirmación distinta y potencialmente
 * falsa de "no medimos esto acá").
 */

export interface CommercialMetricsInput {
  rawResults: number;
  acceptedResults: number;
  duplicatesWithinMission: number;
  duplicatesAlreadyInCrm: number;
  companiesCreated: number;
  // Cuántas de las companyValidations tienen confianza real (EXACT/STRONG/
  // APPROXIMATE -- status VALIDATED/PROBABLE, ver business-validation.ts)
  // -- nunca WEAK/REJECTED (esas nunca llegan a Lead/Opportunity de todos modos).
  validatedCompanies: number;
  companiesConsidered: number;
  companiesWithContactPoint: number;
  emailsFound: number;
  emailsVerified: number;
  leadsCreated: number;
  opportunitiesCreated: number;
  draftsCreated: number;
  // F34: null = "no se cruzó con EmailMessage en esta capa", nunca "cero
  // envíos reales" -- ver comentario de diseño arriba.
  emailsSent: number | null;
  emailsDelivered: number | null;
  hardBounces: number | null;
  spamBlocked: number | null;
  repliesReceived: number | null;
  meetingsBooked: number | null;
  costUsd: number;
}

export interface CommercialMetricsResult {
  noveltyRate: number | null;
  duplicateRate: number | null;
  validatedCompanyRate: number | null;
  contactCoverageRate: number | null;
  emailCoverageRate: number | null;
  verifiedEmailRate: number | null;
  leadRate: number | null;
  opportunityRate: number | null;
  draftRate: number | null;
  deliveredRate: number | null;
  hardBounceRate: number | null;
  spamBlockedRate: number | null;
  replyRate: number | null;
  meetingRate: number | null;
  costPerValidatedCompany: number | null;
  costPerLead: number | null;
  costPerOpportunity: number | null;
  costPerReply: number | null;
  costPerMeeting: number | null;
}

/** Nunca divide por cero, nunca fabrica un resultado cuando falta un operando real. Redondea a 4 decimales -- suficiente precisión para un ratio 0-1 sin ruido de punto flotante. */
function safeDivide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function safeCostPer(costUsd: number, count: number | null): number | null {
  if (count === null || count === 0) return null;
  return Number((costUsd / count).toFixed(4));
}

export function computeCommercialMetrics(input: CommercialMetricsInput): CommercialMetricsResult {
  const totalDuplicates = input.duplicatesWithinMission + input.duplicatesAlreadyInCrm;

  return {
    noveltyRate: safeDivide(input.acceptedResults, input.rawResults),
    duplicateRate: safeDivide(totalDuplicates, input.rawResults),
    validatedCompanyRate: safeDivide(input.validatedCompanies, input.companiesCreated),
    contactCoverageRate: safeDivide(input.companiesWithContactPoint, input.companiesConsidered),
    emailCoverageRate: safeDivide(input.emailsFound, input.companiesCreated),
    verifiedEmailRate: safeDivide(input.emailsVerified, input.emailsFound),
    leadRate: safeDivide(input.leadsCreated, input.companiesCreated),
    opportunityRate: safeDivide(input.opportunitiesCreated, input.leadsCreated),
    draftRate: safeDivide(input.draftsCreated, input.opportunitiesCreated),
    deliveredRate: safeDivide(input.emailsDelivered, input.emailsSent),
    hardBounceRate: safeDivide(input.hardBounces, input.emailsSent),
    spamBlockedRate: safeDivide(input.spamBlocked, input.emailsSent),
    replyRate: safeDivide(input.repliesReceived, input.emailsSent),
    meetingRate: safeDivide(input.meetingsBooked, input.emailsSent),
    costPerValidatedCompany: safeCostPer(input.costUsd, input.validatedCompanies),
    costPerLead: safeCostPer(input.costUsd, input.leadsCreated),
    costPerOpportunity: safeCostPer(input.costUsd, input.opportunitiesCreated),
    costPerReply: safeCostPer(input.costUsd, input.repliesReceived),
    costPerMeeting: safeCostPer(input.costUsd, input.meetingsBooked),
  };
}

/**
 * Agrega varias misiones de la MISMA industria/trade en una sola vista --
 * pedido explícito ("métricas por industria Y por misión"). Suma los
 * conteos reales antes de calcular ratios (nunca promedia ratios ya
 * calculados, que distorsiona con muestras de tamaño distinto).
 */
export function aggregateCommercialMetrics(missions: CommercialMetricsInput[]): CommercialMetricsResult {
  if (missions.length === 0) {
    return computeCommercialMetrics({
      rawResults: 0,
      acceptedResults: 0,
      duplicatesWithinMission: 0,
      duplicatesAlreadyInCrm: 0,
      companiesCreated: 0,
      validatedCompanies: 0,
      companiesConsidered: 0,
      companiesWithContactPoint: 0,
      emailsFound: 0,
      emailsVerified: 0,
      leadsCreated: 0,
      opportunitiesCreated: 0,
      draftsCreated: 0,
      emailsSent: null,
      emailsDelivered: null,
      hardBounces: null,
      spamBlocked: null,
      repliesReceived: null,
      meetingsBooked: null,
      costUsd: 0,
    });
  }

  const sumNullable = (values: Array<number | null>): number | null => {
    const real = values.filter((v): v is number => v !== null);
    // F34: si NINGUNA misión de la industria tiene el dato, el agregado
    // tampoco lo tiene (null, nunca 0) -- pero si AL MENOS una sí lo
    // reportó, se suma lo que hay (las que no reportaron simplemente no
    // aportan, nunca se asume que su valor real era 0).
    return real.length === 0 ? null : real.reduce((sum, v) => sum + v, 0);
  };

  return computeCommercialMetrics({
    rawResults: missions.reduce((s, m) => s + m.rawResults, 0),
    acceptedResults: missions.reduce((s, m) => s + m.acceptedResults, 0),
    duplicatesWithinMission: missions.reduce((s, m) => s + m.duplicatesWithinMission, 0),
    duplicatesAlreadyInCrm: missions.reduce((s, m) => s + m.duplicatesAlreadyInCrm, 0),
    companiesCreated: missions.reduce((s, m) => s + m.companiesCreated, 0),
    validatedCompanies: missions.reduce((s, m) => s + m.validatedCompanies, 0),
    companiesConsidered: missions.reduce((s, m) => s + m.companiesConsidered, 0),
    companiesWithContactPoint: missions.reduce((s, m) => s + m.companiesWithContactPoint, 0),
    emailsFound: missions.reduce((s, m) => s + m.emailsFound, 0),
    emailsVerified: missions.reduce((s, m) => s + m.emailsVerified, 0),
    leadsCreated: missions.reduce((s, m) => s + m.leadsCreated, 0),
    opportunitiesCreated: missions.reduce((s, m) => s + m.opportunitiesCreated, 0),
    draftsCreated: missions.reduce((s, m) => s + m.draftsCreated, 0),
    emailsSent: sumNullable(missions.map((m) => m.emailsSent)),
    emailsDelivered: sumNullable(missions.map((m) => m.emailsDelivered)),
    hardBounces: sumNullable(missions.map((m) => m.hardBounces)),
    spamBlocked: sumNullable(missions.map((m) => m.spamBlocked)),
    repliesReceived: sumNullable(missions.map((m) => m.repliesReceived)),
    meetingsBooked: sumNullable(missions.map((m) => m.meetingsBooked)),
    costUsd: missions.reduce((s, m) => s + m.costUsd, 0),
  });
}
