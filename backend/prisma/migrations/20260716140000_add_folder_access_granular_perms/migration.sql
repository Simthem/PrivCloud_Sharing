-- AlterTable
ALTER TABLE "TeamFolderAccess" ADD COLUMN "canDownload" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TeamFolderAccess" ADD COLUMN "canDelete" BOOLEAN NOT NULL DEFAULT true;
