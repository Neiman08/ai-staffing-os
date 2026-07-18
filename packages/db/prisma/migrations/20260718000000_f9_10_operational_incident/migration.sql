-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('NO_SHOW', 'LATE_ARRIVAL', 'EARLY_DEPARTURE', 'ATTENDANCE', 'SAFETY', 'CLIENT_COMPLAINT', 'WORKER_COMPLAINT', 'TIME_DISCREPANCY', 'DOCUMENT_ISSUE', 'COMPLIANCE_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "OperationalIncident" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "IncidentType" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "workerId" TEXT,
    "assignmentId" TEXT,
    "companyId" TEXT,
    "jobOrderId" TEXT,
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reportedById" TEXT,
    "resolutionNotes" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalIncident_tenantId_status_idx" ON "OperationalIncident"("tenantId", "status");

-- CreateIndex
CREATE INDEX "OperationalIncident_tenantId_workerId_idx" ON "OperationalIncident"("tenantId", "workerId");

-- CreateIndex
CREATE INDEX "OperationalIncident_tenantId_type_idx" ON "OperationalIncident"("tenantId", "type");

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIncident" ADD CONSTRAINT "OperationalIncident_jobOrderId_fkey" FOREIGN KEY ("jobOrderId") REFERENCES "JobOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
