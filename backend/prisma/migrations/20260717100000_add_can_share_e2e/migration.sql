-- Add E2EE sharing permission to folder-level and file-level access rules.
ALTER TABLE "TeamFolderAccess" ADD COLUMN "canShareE2E" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FileAccess" ADD COLUMN "canShareE2E" BOOLEAN NOT NULL DEFAULT false;

-- Existing WRITE/ADMIN folder permissions may share encrypted files by default.
UPDATE "TeamFolderAccess"
SET "canShareE2E" = true
WHERE "permission" IN ('WRITE', 'ADMIN');
