-- Per-member feature access flags (controlled by OWNER/ADMIN).
-- Defaults to false: new members cannot see activity or signatures
-- until explicitly granted by an admin.
ALTER TABLE "TeamMember" ADD COLUMN "canViewActivity" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TeamMember" ADD COLUMN "canViewSignatures" BOOLEAN NOT NULL DEFAULT false;
