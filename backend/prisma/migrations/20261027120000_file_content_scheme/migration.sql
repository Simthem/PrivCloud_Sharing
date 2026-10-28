-- E2EE content format of a file. NULL for every existing file, which is v1.
-- Nullable and without default, so a previous version keeps inserting rows.
ALTER TABLE "File" ADD COLUMN "contentScheme" INTEGER;
