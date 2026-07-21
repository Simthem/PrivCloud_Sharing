-- Public OSS Team governance, assisted E2EE key rotation and PAdES support.
-- SQLite-compatible migration: no subscription, billing or plan columns.

ALTER TABLE "Team" ADD COLUMN "reportEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Team" ADD COLUMN "keyVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Team" ADD COLUMN "keyRotatedAt" DATETIME;
ALTER TABLE "Team" ADD COLUMN "keyRotationIntervalDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Team" ADD COLUMN "keyRotationReminderDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "Team" ADD COLUMN "lastKeyRotationReminderAt" DATETIME;

ALTER TABLE "TeamMember" ADD COLUMN "teamKeyVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TeamMember" ADD COLUMN "teamKeyUpdatedAt" DATETIME;

UPDATE "TeamMember"
SET "teamKeyVersion" = 1,
    "teamKeyUpdatedAt" = "updatedAt"
WHERE "wrappedTeamKey" IS NOT NULL;

UPDATE "Team"
SET "keyRotatedAt" = "createdAt"
WHERE EXISTS (
  SELECT 1 FROM "TeamMember"
  WHERE "TeamMember"."teamId" = "Team"."id"
    AND "TeamMember"."wrappedTeamKey" IS NOT NULL
);

ALTER TABLE "TeamAccessLog" ADD COLUMN "targetType" TEXT;
ALTER TABLE "TeamAccessLog" ADD COLUMN "targetId" TEXT;
ALTER TABLE "TeamAccessLog" ADD COLUMN "metadata" TEXT;

ALTER TABLE "File" ADD COLUMN "encryptionChunkSize" INTEGER;

ALTER TABLE "SignatureDocument" ADD COLUMN "certificatePageKey" TEXT;
ALTER TABLE "SignatureDocument" ADD COLUMN "completedAt" DATETIME;
-- signaturePage and watermarkPage already belong to the consolidated
-- 20260610120000 schema. Re-adding them makes upgraded SQLite databases fail
-- with "duplicate column name" and leaves Prisma in P3009.
ALTER TABLE "SignatureDocument" ADD COLUMN "fileDeletedAt" DATETIME;

CREATE TABLE "TeamAuditReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "frequency" TEXT NOT NULL,
  "periodStart" DATETIME NOT NULL,
  "periodEnd" DATETIME NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'GENERATED',
  "summary" TEXT NOT NULL,
  "recipientEmails" TEXT NOT NULL,
  "sentAt" DATETIME,
  "error" TEXT,
  "teamId" TEXT NOT NULL,
  CONSTRAINT "TeamAuditReport_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TeamKeyRotation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "fromVersion" INTEGER NOT NULL,
  "toVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARING',
  "reason" TEXT NOT NULL DEFAULT 'MANUAL',
  "startedById" TEXT NOT NULL,
  "initiatorWrappedKey" TEXT NOT NULL,
  "totalFiles" INTEGER NOT NULL DEFAULT 0,
  "processedFiles" INTEGER NOT NULL DEFAULT 0,
  "failedFiles" INTEGER NOT NULL DEFAULT 0,
  "completedFileIds" TEXT NOT NULL DEFAULT '[]',
  "errorMessage" TEXT,
  "completedAt" DATETIME,
  "teamId" TEXT NOT NULL,
  CONSTRAINT "TeamKeyRotation_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TeamAuditReport_teamId_frequency_periodStart_periodEnd_key"
  ON "TeamAuditReport"("teamId", "frequency", "periodStart", "periodEnd");
CREATE INDEX "TeamAuditReport_teamId_createdAt_idx"
  ON "TeamAuditReport"("teamId", "createdAt");
CREATE INDEX "TeamKeyRotation_teamId_status_idx"
  ON "TeamKeyRotation"("teamId", "status");
CREATE INDEX "TeamKeyRotation_teamId_createdAt_idx"
  ON "TeamKeyRotation"("teamId", "createdAt");
CREATE INDEX "TeamAccessLog_teamId_createdAt_idx"
  ON "TeamAccessLog"("teamId", "createdAt");
CREATE INDEX "TeamAccessLog_teamId_action_createdAt_idx"
  ON "TeamAccessLog"("teamId", "action", "createdAt");
CREATE INDEX "Share_teamFolderId_uploadLocked_createdAt_idx"
  ON "Share"("teamFolderId", "uploadLocked", "createdAt");
CREATE INDEX "Share_creatorId_teamFolderId_uploadLocked_idx"
  ON "Share"("creatorId", "teamFolderId", "uploadLocked");
CREATE INDEX "File_shareId_idx" ON "File"("shareId");
CREATE INDEX "SignatureDocument_teamId_createdAt_idx"
  ON "SignatureDocument"("teamId", "createdAt");
CREATE INDEX "TeamFolder_teamId_parentId_idx"
  ON "TeamFolder"("teamId", "parentId");
CREATE INDEX "AccessGrant_userId_status_createdAt_idx"
  ON "AccessGrant"("userId", "status", "createdAt");
CREATE INDEX "AccessGrant_grantorId_status_createdAt_idx"
  ON "AccessGrant"("grantorId", "status", "createdAt");
