/**
 * F8.8: Screening Intelligence -- puro, determinista, sin Prisma/fetch/
 * LLM. Genera un PLAN de preguntas de screening para UN candidato
 * contra UN Job Order -- nunca entrevista realmente, nunca contacta al
 * candidato, nunca inventa respuestas, nunca aprueba/rechaza
 * automáticamente. Reutiliza DIRECTAMENTE los campos ya calculados por
 * F8.2 (`QualificationEvaluationResult`) y F8.5
 * (`PersistedQualificationStatus`) como única fuente de hechos sobre el
 * candidato -- nunca vuelve a evaluar documentos/categoría/experiencia.
 *
 * Ninguna pregunta generada referencia ni depende de un atributo
 * protegido (raza, género, edad, religión, nacionalidad, discapacidad,
 * embarazo, estado civil, origen nacional, antecedentes penales,
 * estatus migratorio) -- ver `screening-plan.test.ts` para la prueba
 * explícita de fairness sobre el TEXTO generado, no solo los nombres de
 * campo (una pregunta ilegal podría colarse en el texto aunque el shape
 * de datos sea limpio).
 */

import type { QualificationEvaluationResult } from "./qualification-rules";
import type { PersistedQualificationStatus } from "./qualification-status";

export const SCREENING_PLAN_VERSION = 1;

/**
 * Lista blanca, fija y explícita de razones de descalificación
 * LEGÍTIMAS que un reclutador humano puede invocar tras el screening --
 * política, no un cálculo derivado del candidato. Ninguna de estas
 * razones es ni puede ser un atributo protegido; `rulesVersion` sube si
 * esta lista cambia.
 */
export const ALLOWED_DISQUALIFIERS = [
  "category_mismatch",
  "missing_required_document",
  "document_expired",
  "cannot_meet_start_date",
  "unable_to_perform_essential_job_functions_as_described",
  "unverifiable_work_history",
] as const;

export interface ScreeningQuestion {
  id: string;
  question: string;
  rationale: string;
  expectedEvidence: string;
}

export interface ScreeningPlanInput {
  candidateId: string;
  jobOrderId: string;
  categoryName: string;
  qualification: QualificationEvaluationResult;
  qualificationStatus: PersistedQualificationStatus;
}

export interface ScreeningPlanResult {
  candidateId: string;
  jobOrderId: string;
  questions: ScreeningQuestion[];
  allowedDisqualifiers: string[];
  manualReviewFlags: string[];
  missingInformation: string[];
  riskFlags: string[];
  rulesVersion: number;
  calculatedAt: string;
}

function buildBaselineQuestions(categoryName: string): ScreeningQuestion[] {
  return [
    {
      id: "availability_start_date",
      question: `¿Cuál es su disponibilidad real para iniciar en el puesto de ${categoryName}?`,
      rationale: "Confirmar alineación con la fecha de inicio requerida por el Job Order.",
      expectedEvidence: "Fecha concreta de disponibilidad declarada por el candidato.",
    },
    {
      id: "role_experience",
      question: `Describa su experiencia previa relevante para el puesto de ${categoryName}.`,
      rationale: "Verificar de forma cualitativa la experiencia ya declarada en el perfil.",
      expectedEvidence: "Ejemplos concretos y verificables de trabajo previo en la categoría.",
    },
    {
      id: "compliance_acknowledgment",
      question: "¿Está de acuerdo en cumplir con las políticas de seguridad y cumplimiento operativo del cliente?",
      rationale: "Confirmar disposición a cumplir requisitos operativos del puesto -- nunca condicionado por atributos personales.",
      expectedEvidence: "Confirmación explícita del candidato.",
    },
  ];
}

/**
 * Construye el plan de screening. Determinista: el mismo
 * `ScreeningPlanInput` siempre produce el mismo plan (mismo orden de
 * preguntas, mismo texto).
 */
export function buildScreeningPlan(input: ScreeningPlanInput, now: Date = new Date()): ScreeningPlanResult {
  const { qualification } = input;
  const questions = buildBaselineQuestions(input.categoryName);

  const missingOrExpiredDocs = [...qualification.missingDocuments, ...qualification.expiredDocuments];
  if (missingOrExpiredDocs.length > 0) {
    questions.push({
      id: "document_readiness",
      question: `¿Puede proporcionar o renovar los siguientes documentos requeridos: ${missingOrExpiredDocs.join(", ")}?`,
      rationale: "Confirmar viabilidad de cumplir los requisitos documentales antes de avanzar.",
      expectedEvidence: "Documento cargado y verificado, o una fecha concreta comprometida de entrega.",
    });
  }

  if (qualification.experienceGap) {
    questions.push({
      id: "experience_gap_probe",
      question: "Describa un proyecto o tarea reciente que demuestre su capacidad para cumplir los requisitos de experiencia del puesto.",
      rationale: "La experiencia declarada está por debajo del mínimo requerido -- se busca evidencia cualitativa compensatoria.",
      expectedEvidence: "Ejemplo concreto y verificable que demuestre competencia equivalente.",
    });
  }

  if (qualification.languageGaps.length > 0) {
    questions.push({
      id: "language_verification",
      question: `¿Puede demostrar manejo funcional de: ${qualification.languageGaps.join(", ")}?`,
      rationale: "Verificar un idioma requerido por el Job Order que no está declarado en el perfil.",
      expectedEvidence: "Demostración práctica durante el screening (ej. una breve conversación en el idioma).",
    });
  }

  const manualReviewFlags: string[] = [];
  if (input.qualificationStatus === "NEEDS_REVIEW") {
    manualReviewFlags.push("Requiere revisión manual de documentos antes de continuar.");
  }
  if (input.qualificationStatus === "NOT_QUALIFIED") {
    manualReviewFlags.push("Candidato NOT_QUALIFIED -- el screening no debe avanzar sin una revisión humana explícita.");
  }

  const missingInformation: string[] = [];
  if (qualification.missingDocuments.length > 0) {
    missingInformation.push(`Documentos faltantes: ${qualification.missingDocuments.join(", ")}.`);
  }
  if (qualification.expiredDocuments.length > 0) {
    missingInformation.push(`Documentos vencidos: ${qualification.expiredDocuments.join(", ")}.`);
  }

  const riskFlags: string[] = [];
  if (qualification.hardDisqualifiers.length > 0) {
    riskFlags.push(`Descalificadores duros detectados: ${qualification.hardDisqualifiers.join(", ")}.`);
  }
  if (qualification.experienceGap) {
    riskFlags.push("Gap de experiencia respecto al mínimo requerido por el Job Order.");
  }
  if (qualification.languageGaps.length > 0) {
    riskFlags.push(`Idiomas requeridos no confirmados: ${qualification.languageGaps.join(", ")}.`);
  }

  return {
    candidateId: input.candidateId,
    jobOrderId: input.jobOrderId,
    questions,
    allowedDisqualifiers: [...ALLOWED_DISQUALIFIERS],
    manualReviewFlags,
    missingInformation,
    riskFlags,
    rulesVersion: SCREENING_PLAN_VERSION,
    calculatedAt: now.toISOString(),
  };
}
