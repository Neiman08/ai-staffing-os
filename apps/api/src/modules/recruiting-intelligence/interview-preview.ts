/**
 * F8.9: Interview Scheduling Preview -- puro, determinista, sin
 * Prisma/fetch/LLM. Prepara y valida un PREVIEW de programación de
 * entrevista para UN candidato contra UN Job Order -- nunca modifica un
 * calendario real, nunca envía invitaciones/email, nunca crea una
 * reunión externa, nunca afirma disponibilidad real si no hay
 * integración conectada (no la hay en este proyecto). Las ventanas
 * horarias propuestas (`proposedWindows`) son SIEMPRE input humano (el
 * recruiter las propone) -- este módulo nunca las inventa, solo valida
 * completitud y detecta conflictos entre previews ya existentes.
 *
 * Reutiliza `matching/date-overlap.ts` (F6.2, puro, sin Prisma) para la
 * detección de solapamiento de ventanas -- misma fórmula de rango
 * cerrado/abierto, sin duplicar la lógica de comparación de fechas.
 */

import { doDateRangesOverlap } from "../matching/date-overlap";

export const INTERVIEW_PREVIEW_VERSION = 1;

export type InterviewModality = "PHONE" | "VIDEO" | "IN_PERSON";
export type InterviewPreviewStatus = "DRAFT" | "NEEDS_AVAILABILITY" | "READY_FOR_APPROVAL" | "APPROVED_FOR_SEND" | "CANCELLED";

/**
 * Grafo de transiciones manuales -- el estado derivado por
 * `computeInterviewPreviewStatus` (DRAFT/NEEDS_AVAILABILITY/
 * READY_FOR_APPROVAL) es un PUNTO DE PARTIDA sugerido; `APPROVED_FOR_SEND`
 * y `CANCELLED` son SIEMPRE una acción humana explícita, nunca derivadas
 * automáticamente del input.
 */
export const INTERVIEW_PREVIEW_TRANSITIONS: Record<InterviewPreviewStatus, InterviewPreviewStatus[]> = {
  DRAFT: ["NEEDS_AVAILABILITY", "READY_FOR_APPROVAL", "CANCELLED"],
  NEEDS_AVAILABILITY: ["DRAFT", "READY_FOR_APPROVAL", "CANCELLED"],
  READY_FOR_APPROVAL: ["DRAFT", "NEEDS_AVAILABILITY", "APPROVED_FOR_SEND", "CANCELLED"],
  APPROVED_FOR_SEND: ["CANCELLED"],
  CANCELLED: ["DRAFT"],
};

export function isValidInterviewPreviewTransition(from: InterviewPreviewStatus, to: InterviewPreviewStatus): boolean {
  if (from === to) return true;
  return INTERVIEW_PREVIEW_TRANSITIONS[from].includes(to);
}

export interface ProposedWindow {
  start: string | Date;
  end: string | Date;
}

export interface InterviewParticipant {
  role: string;
  name: string;
}

export interface ExistingPreviewWindow {
  interviewPreviewId: string;
  start: string | Date;
  end: string | Date;
}

export interface InterviewPreviewInput {
  candidateId: string;
  jobOrderId: string;
  proposedWindows: ProposedWindow[];
  durationMinutes: number;
  timezone: string;
  modality: InterviewModality;
  locationOrLink: string | null;
  participants: InterviewParticipant[];
  restrictions: string[];
  /** Otros previews YA persistidos para el mismo candidato -- para detectar conflictos, nunca para inventar disponibilidad. */
  existingWindows?: ExistingPreviewWindow[];
}

export interface InterviewPreviewResult {
  candidateId: string;
  jobOrderId: string;
  status: InterviewPreviewStatus;
  proposedWindows: ProposedWindow[];
  durationMinutes: number;
  timezone: string;
  modality: InterviewModality;
  locationOrLink: string | null;
  participants: InterviewParticipant[];
  restrictions: string[];
  conflicts: Array<{ withInterviewPreviewId: string; window: ProposedWindow }>;
  /** Siempre `false` en este módulo -- la disponibilidad NUNCA es "confirmada" sin integración real de calendario (no existe en este proyecto). Documentado explícitamente para que la UI nunca la presente como real. */
  availabilityConfirmed: false;
  missingInformation: string[];
  rulesVersion: number;
  calculatedAt: string;
}

function computeMissingInformation(input: InterviewPreviewInput): string[] {
  const missing: string[] = [];
  if (input.proposedWindows.length === 0) missing.push("proposedWindows");
  if (input.durationMinutes <= 0) missing.push("durationMinutes");
  if (!input.timezone) missing.push("timezone");
  if (input.modality !== "PHONE" && !input.locationOrLink) missing.push("locationOrLink");
  if (input.participants.length === 0) missing.push("participants");
  return missing;
}

function computeConflicts(input: InterviewPreviewInput): Array<{ withInterviewPreviewId: string; window: ProposedWindow }> {
  const conflicts: Array<{ withInterviewPreviewId: string; window: ProposedWindow }> = [];
  const existing = input.existingWindows ?? [];
  for (const proposed of input.proposedWindows) {
    const proposedStart = new Date(proposed.start);
    const proposedEnd = new Date(proposed.end);
    for (const other of existing) {
      const otherStart = new Date(other.start);
      const otherEnd = new Date(other.end);
      if (doDateRangesOverlap(proposedStart, proposedEnd, otherStart, otherEnd)) {
        conflicts.push({ withInterviewPreviewId: other.interviewPreviewId, window: proposed });
      }
    }
  }
  return conflicts;
}

/**
 * Deriva el estado SUGERIDO (nunca `APPROVED_FOR_SEND`/`CANCELLED`,
 * esos son siempre una acción humana explícita, ver
 * `isValidInterviewPreviewTransition`):
 * - `NEEDS_AVAILABILITY` si no hay ninguna ventana propuesta.
 * - `DRAFT` si faltan datos (duración/timezone/ubicación-o-enlace/
 *   participantes) o hay conflictos sin resolver.
 * - `READY_FOR_APPROVAL` si todo está completo y sin conflictos.
 */
export function computeInterviewPreviewStatus(missingInformation: string[], conflicts: unknown[]): InterviewPreviewStatus {
  if (missingInformation.includes("proposedWindows")) return "NEEDS_AVAILABILITY";
  if (missingInformation.length > 0 || conflicts.length > 0) return "DRAFT";
  return "READY_FOR_APPROVAL";
}

/**
 * Construye el preview completo. Determinista: el mismo input siempre
 * produce el mismo resultado. `availabilityConfirmed` es SIEMPRE
 * `false` -- ver el comentario del campo.
 */
export function buildInterviewPreview(input: InterviewPreviewInput, now: Date = new Date()): InterviewPreviewResult {
  const missingInformation = computeMissingInformation(input);
  const conflicts = computeConflicts(input);
  const status = computeInterviewPreviewStatus(missingInformation, conflicts);

  return {
    candidateId: input.candidateId,
    jobOrderId: input.jobOrderId,
    status,
    proposedWindows: input.proposedWindows,
    durationMinutes: input.durationMinutes,
    timezone: input.timezone,
    modality: input.modality,
    locationOrLink: input.locationOrLink,
    participants: input.participants,
    restrictions: input.restrictions,
    conflicts,
    availabilityConfirmed: false,
    missingInformation,
    rulesVersion: INTERVIEW_PREVIEW_VERSION,
    calculatedAt: now.toISOString(),
  };
}
