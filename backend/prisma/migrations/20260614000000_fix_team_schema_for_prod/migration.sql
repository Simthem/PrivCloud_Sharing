-- =============================================================================
-- Corrective migration: fix Team-related tables for prod DB
--
-- On a fresh database, migration 20260610120000_add_signing_and_teams already
-- creates all tables with the correct schema. This migration is only needed
-- for production databases where the original migration was applied with an
-- incomplete schema.
--
-- Since Prisma replays all migrations on fresh/shadow DBs, and the original
-- migration already includes the full schema, this is a no-op on fresh DBs.
-- For production, apply the corrective SQL manually via prisma db execute.
-- =============================================================================

SELECT 1;
