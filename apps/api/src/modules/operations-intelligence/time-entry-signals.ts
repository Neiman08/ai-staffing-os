/**
 * F9.6: Shift and Time Structure -- puro, determinista, sin Prisma/
 * fetch/LLM. Calcula señales de revisión (overtime/discrepancy) sobre
 * un `TimeEntry` -- NUNCA aprueba, rechaza, ni inventa horas. Son
 * banderas para que un humano revise, nunca una decisión automática
 * (mismo criterio que F8's `manualReviewFlags`).
 *
 * El grafo canónico de transiciones de TimeEntryStatus vive en
 * `@ai-staffing-os/shared` (mismo patrón que Assignment/Candidate/
 * Worker) -- este módulo lo re-exporta en vez de duplicarlo.
 */
import {
  TIME_ENTRY_STATUS_TRANSITIONS,
  isValidTimeEntryStatusTransition,
  type TimeEntryStatusValue,
} from "@ai-staffing-os/shared";

export { TIME_ENTRY_STATUS_TRANSITIONS, isValidTimeEntryStatusTransition };
export type TimeEntryStatusExtended = TimeEntryStatusValue;

export const TIME_ENTRY_SIGNALS_VERSION = 1;

const OVERTIME_DAILY_THRESHOLD_HOURS = 8;
/** Umbral de discrepancia contra la duración programada del Shift -- una diferencia menor se considera ruido de registro manual, no una señal real. */
const DISCREPANCY_THRESHOLD_HOURS = 1;

export interface TimeEntryHoursInput {
  regularHours: number;
  overtimeHours: number;
  doubleHours: number;
}

/**
 * Bandera de overtime -- puramente informativa (nunca calcula
 * obligaciones legales de horas extra reales, eso queda fuera del
 * alcance de un motor automático). Se activa si ya hay
 * `overtimeHours`/`doubleHours` declaradas, o si el total del día
 * supera el umbral estándar de 8 horas.
 */
export function computeOvertimeFlag(hours: TimeEntryHoursInput): boolean {
  if (hours.overtimeHours > 0 || hours.doubleHours > 0) return true;
  const total = hours.regularHours + hours.overtimeHours + hours.doubleHours;
  return total > OVERTIME_DAILY_THRESHOLD_HOURS;
}

export interface ScheduledShiftDuration {
  /** Duración programada en horas, ya resuelta por el wiring impuro (maneja turnos que cruzan medianoche). */
  scheduledHours: number;
}

/**
 * Bandera de discrepancia -- compara el total de horas registradas
 * contra la duración PROGRAMADA de un `Shift` real (si existe uno para
 * el mismo Assignment+fecha). Sin Shift programado, nunca hay
 * discrepancia que evaluar (no se inventa una expectativa).
 */
export function computeDiscrepancyFlag(hours: TimeEntryHoursInput, scheduled: ScheduledShiftDuration | null): { flag: boolean; notes: string | null } {
  if (!scheduled) return { flag: false, notes: null };
  const total = hours.regularHours + hours.overtimeHours + hours.doubleHours;
  const diff = Math.abs(total - scheduled.scheduledHours);
  if (diff <= DISCREPANCY_THRESHOLD_HOURS) return { flag: false, notes: null };
  return {
    flag: true,
    notes: `Logged ${total}h vs scheduled ${scheduled.scheduledHours}h (diff ${diff.toFixed(2)}h) -- requires manual review.`,
  };
}

/**
 * Duración en horas de un Shift a partir de sus horarios "HH:MM" --
 * maneja turnos que cruzan medianoche (endTime < startTime = termina al
 * día siguiente), mismo criterio que un turno nocturno real (ej.
 * 22:00-06:00 = 8 horas, no un valor negativo).
 */
export function computeShiftScheduledHours(startTime: string, endTime: string, breakMinutes: number): number {
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  let endMinutes = (endH ?? 0) * 60 + (endM ?? 0);
  if (endMinutes <= startMinutes) endMinutes += 24 * 60; // cruza medianoche
  const grossMinutes = endMinutes - startMinutes;
  const netMinutes = Math.max(0, grossMinutes - breakMinutes);
  return netMinutes / 60;
}

/** Al enviar un DRAFT: si hay discrepancia real, va a NEEDS_REVIEW; si no, a SUBMITTED. Determinista, nunca decide aprobar/rechazar por sí solo. */
export function computeSubmissionTargetStatus(hasDiscrepancy: boolean): "SUBMITTED" | "NEEDS_REVIEW" {
  return hasDiscrepancy ? "NEEDS_REVIEW" : "SUBMITTED";
}
