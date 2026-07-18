// F10.4: tipos locales al frontend para los DTOs de /portal/worker/*.

export interface WorkerProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  languages: string[];
  availabilityNotes: string | null;
  skills: string[];
  employmentType: string;
  defaultPayRate: string;
  status: string;
  complianceStatus: string;
  hiredAt: string | null;
}

export interface WorkerOnboardingSummaryItem {
  id: string;
  jobOrderId: string;
  jobOrderTitle: string;
  status: string;
  progress: number;
  nextBestAction: string;
}

export interface WorkerDocumentItem {
  id: string;
  label: string;
  status: string;
  required: boolean;
  expiresAt: string | null;
  rejectionReason: string | null;
}

export interface WorkerAssignmentLocation {
  city?: string;
  state?: string;
  address?: string;
}

export interface WorkerAssignmentItem {
  id: string;
  jobOrderTitle: string;
  companyName: string;
  status: string;
  startDate: string;
  endDate: string | null;
  location: WorkerAssignmentLocation | null;
  shiftType: string;
  scheduleNotes: string | null;
  supervisorName: string | null;
}

export interface WorkerShiftItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  timezone: string | null;
}

export interface WorkerScheduleChangeRequestItem {
  id: string;
  assignmentId: string;
  requestType: string;
  requestedChange: string;
  status: string;
  reviewNotes: string | null;
  createdAt: string;
}

export interface WorkerTimeEntryItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  regularHours: string;
  overtimeHours: string;
  doubleHours: string;
  status: string;
  rejectionReason: string | null;
}

export interface WorkerIncidentItem {
  id: string;
  assignmentId: string | null;
  type: string;
  status: string;
  description: string;
  occurredAt: string;
}
