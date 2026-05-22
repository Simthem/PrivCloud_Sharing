-- =============================================================================
-- Migration: Add teamFolderId to Share table
--
-- Allows shares to be associated with a team folder.
-- This is a non-destructive migration: adds a nullable column + index.
-- No data loss, no table recreation needed.
-- =============================================================================

-- Add nullable teamFolderId column to Share
ALTER TABLE "Share" ADD COLUMN "teamFolderId" TEXT;

-- Create index for faster lookups by team folder
CREATE INDEX "Share_teamFolderId_idx" ON "Share"("teamFolderId");
