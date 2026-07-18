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

export interface WorkerAssignmentItem {
  id: string;
  jobOrderTitle: string;
  companyName: string;
  status: string;
  startDate: string;
  endDate: string | null;
}

export interface WorkerShiftItem {
  id: string;
  assignmentId: string;
  jobOrderTitle: string;
  date: string;
  startTime: string;
  endTime: string;
  timezone: string | null;
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
  type: string;
  status: string;
  description: string;
  occurredAt: string;
}
