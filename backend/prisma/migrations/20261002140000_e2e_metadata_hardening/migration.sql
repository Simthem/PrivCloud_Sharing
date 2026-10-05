PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Add encrypted labels and hybrid grant ciphertexts. Existing rows keep NULL.

ALTER TABLE "AccessGrant" ADD COLUMN "kemCiphertext" TEXT;

CREATE TRIGGER "AccessGrant_kemCiphertext_check_insert"
BEFORE INSERT ON "AccessGrant"
WHEN NOT ((NEW."algorithm" = 'x25519-mlkem768-aes256gcm') = (NEW."kemCiphertext" IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'AccessGrant.kemCiphertext inconsistent with readable data or algorithm');
END;

CREATE TRIGGER "AccessGrant_kemCiphertext_check_update"
BEFORE UPDATE OF "kemCiphertext", "algorithm" ON "AccessGrant"
WHEN NOT ((NEW."algorithm" = 'x25519-mlkem768-aes256gcm') = (NEW."kemCiphertext" IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'AccessGrant.kemCiphertext inconsistent with readable data or algorithm');
END;

ALTER TABLE "ReverseShare" ADD COLUMN "encryptedName" TEXT;

CREATE TRIGGER "ReverseShare_encryptedName_check_insert"
BEFORE INSERT ON "ReverseShare"
WHEN NOT (NEW."encryptedName" IS NULL OR (NEW."name" IS NULL AND NEW."encryptedReverseShareKey" IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'ReverseShare.encryptedName inconsistent with readable data or algorithm');
END;

CREATE TRIGGER "ReverseShare_encryptedName_check_update"
BEFORE UPDATE OF "encryptedName", "name", "encryptedReverseShareKey" ON "ReverseShare"
WHEN NOT (NEW."encryptedName" IS NULL OR (NEW."name" IS NULL AND NEW."encryptedReverseShareKey" IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'ReverseShare.encryptedName inconsistent with readable data or algorithm');
END;

-- Rebuild only this request table to relax its older inline subject check.
-- Keep every row, index and foreign-key reference. Disable FK actions before
-- the transaction so dropping the old table cannot cascade to its recipients.
CREATE TABLE "new_TeamFileRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "subject" TEXT NOT NULL CHECK (
        length(trim("subject")) BETWEEN 3 AND 120
        OR ("subject" = '' AND "encryptedInfo" IS NOT NULL)
    ),
    "note" TEXT CHECK ("note" IS NULL OR length("note") <= 2000),
    "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'CLOSED')),
    "expiresAt" DATETIME NOT NULL,
    "creatorId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "folderId" TEXT,
    "submissionNotification" TEXT,
    "recipientScope" TEXT NOT NULL DEFAULT 'SELECTED' CHECK ("recipientScope" IN ('ALL', 'SELECTED')),
    "sendEmail" BOOLEAN NOT NULL DEFAULT false,
    "encryptedInfo" TEXT,
    CONSTRAINT "TeamFileRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFileRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFileRequest_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TeamFileRequest" (
    "id", "createdAt", "closedAt", "subject", "note", "status", "expiresAt",
    "creatorId", "teamId", "folderId", "submissionNotification", "recipientScope", "sendEmail"
) SELECT
    "id", "createdAt", "closedAt", "subject", "note", "status", "expiresAt",
    "creatorId", "teamId", "folderId", "submissionNotification", "recipientScope", "sendEmail"
FROM "TeamFileRequest";
DROP TABLE "TeamFileRequest";
ALTER TABLE "new_TeamFileRequest" RENAME TO "TeamFileRequest";
CREATE INDEX "TeamFileRequest_teamId_createdAt_idx" ON "TeamFileRequest"("teamId", "createdAt");
CREATE INDEX "TeamFileRequest_creatorId_createdAt_idx" ON "TeamFileRequest"("creatorId", "createdAt");

CREATE TRIGGER "TeamFileRequest_encryptedInfo_check_insert"
BEFORE INSERT ON "TeamFileRequest"
WHEN NOT (NEW."encryptedInfo" IS NULL OR (NEW."subject" = '' AND NEW."note" IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'TeamFileRequest.encryptedInfo inconsistent with readable data or algorithm');
END;

CREATE TRIGGER "TeamFileRequest_encryptedInfo_check_update"
BEFORE UPDATE OF "encryptedInfo", "subject", "note" ON "TeamFileRequest"
WHEN NOT (NEW."encryptedInfo" IS NULL OR (NEW."subject" = '' AND NEW."note" IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'TeamFileRequest.encryptedInfo inconsistent with readable data or algorithm');
END;

-- Team notifications written by the server before this release could name a
-- member, a team, a folder or a file. They get the generic text of their type
-- (team-notification-messages.ts) and lose their plaintext details, which
-- only served to highlight a file. Encrypted notifications are left as they
-- are.
UPDATE "TeamNotification"
SET
    "title" = CASE "type"
        WHEN 'FILE_SHARED' THEN 'Un fichier a été partagé avec vous / A file was shared with you'
        WHEN 'FILE_UPLOADED' THEN 'Nouveau contenu dans un dossier de votre équipe / New content in one of your team folders'
        WHEN 'FILE_DELETED' THEN 'Des fichiers ont été supprimés dans votre équipe / Files were deleted in your team'
        WHEN 'GRANT_RECEIVED' THEN 'Un accès vous a été accordé / You were granted access'
        WHEN 'GRANT_REVOKED' THEN 'Un de vos accès a été retiré / One of your accesses was removed'
        WHEN 'KEY_ROTATED' THEN 'La clé de votre équipe a été renouvelée / Your team key was renewed'
        WHEN 'MEMBER_JOINED' THEN 'Un membre a rejoint votre équipe / A member joined your team'
        WHEN 'MEMBER_LEFT' THEN 'Un membre a quitté votre équipe / A member left your team'
    END,
    "metadata" = NULL
WHERE "encryptedMetadata" IS NULL
    AND "type" IN (
        'FILE_SHARED',
        'FILE_UPLOADED',
        'FILE_DELETED',
        'GRANT_RECEIVED',
        'GRANT_REVOKED',
        'KEY_ROTATED',
        'MEMBER_JOINED',
        'MEMBER_LEFT'
    );

-- Resumable encrypted label rotation, applied atomically with the new key.
ALTER TABLE "TeamKeyRotation" ADD COLUMN "encryptedMetadataUpdates" TEXT;

COMMIT;
PRAGMA foreign_keys=ON;
