-- Add logical relative paths for folder uploads.
-- Physical storage remains keyed by File.id; this column is only used for UI
-- display and safe ZIP entry names.
ALTER TABLE "File" ADD COLUMN "relativePath" TEXT;
