-- AlterEnum
ALTER TYPE "Modality" ADD VALUE 'ARCHIVE';

-- AlterTable
ALTER TABLE "FileObject" ADD COLUMN     "archiveId" TEXT,
ADD COLUMN     "archivePath" TEXT;

-- CreateIndex
CREATE INDEX "FileObject_archiveId_idx" ON "FileObject"("archiveId");

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "FileObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
