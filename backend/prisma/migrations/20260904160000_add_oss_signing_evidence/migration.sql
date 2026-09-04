-- SQLite-compatible signing assurance, audit retention and encrypted Team
-- notification migration for the open-source distribution.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_SignatureDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "fileName" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "fileKey" TEXT NOT NULL DEFAULT '',
    "originalFileKey" TEXT NOT NULL,
    "signedFileKey" TEXT,
    "certificatePageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "signatureLevel" TEXT NOT NULL DEFAULT 'STANDARD',
    "expiresAt" DATETIME,
    "completedAt" DATETIME,
    "addApprovalMention" BOOLEAN NOT NULL DEFAULT true,
    "addApprovalField" BOOLEAN NOT NULL DEFAULT true,
    "addInitials" BOOLEAN NOT NULL DEFAULT false,
    "initialsPlacement" TEXT NOT NULL DEFAULT 'BOTTOM_CENTER_RIGHT',
    "initialsIncludeSignaturePage" BOOLEAN NOT NULL DEFAULT false,
    "signaturePage" INTEGER,
    "watermarkPage" INTEGER,
    "isE2EEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL DEFAULT '',
    "creatorId" TEXT NOT NULL,
    "shareId" TEXT,
    "fileId" TEXT,
    "fileDeletedAt" DATETIME,
    "teamId" TEXT,
    CONSTRAINT "SignatureDocument_creatorId_fkey"
      FOREIGN KEY ("creatorId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SignatureDocument_fileId_fkey"
      FOREIGN KEY ("fileId") REFERENCES "File" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SignatureDocument_teamId_fkey"
      FOREIGN KEY ("teamId") REFERENCES "Team" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_SignatureDocument" (
    "id", "createdAt", "updatedAt", "fileName", "title", "fileKey",
    "originalFileKey", "signedFileKey", "certificatePageKey", "status",
    "message", "signatureLevel", "expiresAt", "completedAt",
    "addApprovalMention", "addApprovalField", "addInitials",
    "signaturePage", "watermarkPage", "isE2EEncrypted", "ownerId",
    "creatorId", "shareId", "fileId", "fileDeletedAt", "teamId"
)
SELECT
    "id", "createdAt", "updatedAt", "fileName", "title", "fileKey",
    "originalFileKey", "signedFileKey", "certificatePageKey", "status",
    "message",
    CASE WHEN "signatureLevel" IN ('AES', 'QES') THEN 'STANDARD'
         ELSE "signatureLevel" END,
    "expiresAt", "completedAt", "addApprovalMention", "addApprovalField",
    "addInitials", "signaturePage", "watermarkPage", "isE2EEncrypted",
    "ownerId", "creatorId", "shareId",
    CASE WHEN "fileId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "File" WHERE "File"."id" = "SignatureDocument"."fileId"
    ) THEN "fileId" ELSE NULL END,
    CASE WHEN "fileId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "File" WHERE "File"."id" = "SignatureDocument"."fileId"
    ) THEN COALESCE("fileDeletedAt", CURRENT_TIMESTAMP)
    ELSE "fileDeletedAt" END,
    "teamId"
FROM "SignatureDocument";

DROP TABLE "SignatureDocument";
ALTER TABLE "new_SignatureDocument" RENAME TO "SignatureDocument";

CREATE INDEX "SignatureDocument_teamId_createdAt_idx"
  ON "SignatureDocument"("teamId", "createdAt");
CREATE INDEX "SignatureDocument_fileId_idx"
  ON "SignatureDocument"("fileId");
CREATE INDEX "SignatureDocument_fileDeletedAt_idx"
  ON "SignatureDocument"("fileDeletedAt");

CREATE TRIGGER "File_mark_signature_source_deleted"
BEFORE DELETE ON "File"
FOR EACH ROW
BEGIN
  UPDATE "SignatureDocument"
  SET "fileDeletedAt" = COALESCE("fileDeletedAt", CURRENT_TIMESTAMP)
  WHERE "fileId" = OLD."id";
END;

ALTER TABLE "SignatureRecipient"
  ADD COLUMN "teamInviteNotification" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "teamProgressNotification" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "teamCompletionNotification" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "identityVerificationMethod" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "identityVerifiedAt" DATETIME;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "authenticationMethod" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "signingIntentHash" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "signedDocumentHash" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "webauthnCredentialId" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "webauthnAssertion" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "webauthnUserVerified" BOOLEAN;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "webauthnDeviceType" TEXT;
ALTER TABLE "SignatureRecipient"
  ADD COLUMN "webauthnBackedUp" BOOLEAN;

ALTER TABLE "SignatureAuditEvent"
  ADD COLUMN "previousEventHash" TEXT;
ALTER TABLE "SignatureAuditEvent"
  ADD COLUMN "eventHash" TEXT;
CREATE UNIQUE INDEX "SignatureAuditEvent_eventHash_key"
  ON "SignatureAuditEvent"("eventHash");

CREATE TABLE "SigningPasskey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "credentialId" TEXT NOT NULL,
    "publicKey" BLOB NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "label" TEXT,
    "userId" TEXT NOT NULL,
    CONSTRAINT "SigningPasskey_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SigningPasskey_credentialId_key"
  ON "SigningPasskey"("credentialId");
CREATE INDEX "SigningPasskey_userId_idx"
  ON "SigningPasskey"("userId");

CREATE TABLE "SigningWebAuthnChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "purpose" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "intentHash" TEXT,
    "sourceDocumentHash" TEXT,
    "userId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    CONSTRAINT "SigningWebAuthnChallenge_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SigningWebAuthnChallenge_recipientId_fkey"
      FOREIGN KEY ("recipientId") REFERENCES "SignatureRecipient" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SigningWebAuthnChallenge_challenge_key"
  ON "SigningWebAuthnChallenge"("challenge");
CREATE INDEX "SigningWebAuthnChallenge_userId_purpose_expiresAt_idx"
  ON "SigningWebAuthnChallenge"("userId", "purpose", "expiresAt");
CREATE INDEX "SigningWebAuthnChallenge_recipientId_purpose_expiresAt_idx"
  ON "SigningWebAuthnChallenge"("recipientId", "purpose", "expiresAt");

ALTER TABLE "Team"
  ADD COLUMN "pqNotificationEncryptionEnabled" BOOLEAN NOT NULL DEFAULT false;

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
