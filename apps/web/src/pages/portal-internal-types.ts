// F10.3: tipos locales para los DTOs internos de revisión de Client Job
// Requests (/client-job-requests/*, apps/api/.../portal/internal-job-request-service.ts)
// -- mismo criterio que components/recruiting/types.ts: no se agregaron
// a @ai-staffing-os/shared.

export interface InternalJobRequestListItem {
  id: string;
  companyId: string;
  companyName: string;
  requestedTitle: string;
  headcount: number;
  desiredStartDate: string;
  urgency: string;
  status: string;
  createdAt: string;
}

export interface InternalJobRequestDetail {
  id: string;
  companyId: string;
  companyName: string;
  requestedTitle: string;
  location: unknown;
  headcount: number;
  shift: string | null;
  schedule: string | null;
  payRateExpectation: string | null;
  billBudget: string | null;
  desiredStartDate: string;
  duration: string | null;
  requiredSkills: string[];
  certifications: string[];
  languageRequirements: string[];
  physicalRequirements: string | null;
  notes: string | null;
  urgency: string;
  status: string;
  reviewNotes: string | null;
  convertedJobOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

// F10.6: revisión interna de Schedule Change Requests (creadas desde el
// Worker Portal -- ver apps/api/.../assignments/service.ts).
export interface ScheduleChangeRequestListItem {
  id: string;
  assignmentId: string;
  workerName: string;
  jobOrderTitle: string;
  requestType: string;
  requestedChange: string;
  status: string;
  reviewNotes: string | null;
  createdAt: string;
}
