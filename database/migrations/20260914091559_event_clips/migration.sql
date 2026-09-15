-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('READY', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "EventClip" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "clipKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "startTime" DOUBLE PRECISION NOT NULL,
    "endTime" DOUBLE PRECISION NOT NULL,
    "eventTime" DOUBLE PRECISION NOT NULL,
    "kinds" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "status" "ClipStatus" NOT NULL DEFAULT 'READY',
    "unavailableReason" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventClip_workspaceId_createdAt_idx" ON "EventClip"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "EventClip_fileId_startTime_idx" ON "EventClip"("fileId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "EventClip_resultId_clipKey_key" ON "EventClip"("resultId", "clipKey");

-- AddForeignKey
ALTER TABLE "EventClip" ADD CONSTRAINT "EventClip_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventClip" ADD CONSTRAINT "EventClip_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ProcessingResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventClip" ADD CONSTRAINT "EventClip_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
