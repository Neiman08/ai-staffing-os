-- CreateEnum
CREATE TYPE "ScheduleChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ScheduleChangeRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestType" TEXT NOT NULL,
    "requestedChange" TEXT NOT NULL,
    "status" "ScheduleChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleChangeRequest_tenantId_assignmentId_status_idx" ON "ScheduleChangeRequest"("tenantId", "assignmentId", "status");

-- AddForeignKey
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
