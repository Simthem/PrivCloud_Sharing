-- Existing accounts remain permanently exempt: all added User columns are
-- nullable and this migration intentionally performs no UPDATE/backfill.
ALTER TABLE "User" ADD COLUMN "emailVerificationRequiredAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "emailVerificationDeletionStartedAt" DATETIME;

CREATE TABLE "EmailVerificationToken" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "email" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "EmailVerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmailVerificationToken_userId_key"
  ON "EmailVerificationToken"("userId");
CREATE INDEX "EmailVerificationToken_expiresAt_idx"
  ON "EmailVerificationToken"("expiresAt");
CREATE INDEX "User_emailVerifiedAt_emailVerificationRequiredAt_emailVerificationDeletionStartedAt_idx"
  ON "User"("emailVerifiedAt", "emailVerificationRequiredAt", "emailVerificationDeletionStartedAt");

-- SQLite cannot mutate NEW directly. The AFTER INSERT update only affects the
-- row being inserted; pre-existing rows are never touched.
CREATE TRIGGER "User_require_email_verification_on_insert"
AFTER INSERT ON "User"
FOR EACH ROW
WHEN NEW."emailVerificationRequiredAt" IS NULL
 AND NEW."emailVerifiedAt" IS NULL
 AND NEW."ldapDN" IS NULL
BEGIN
  UPDATE "User"
  SET "emailVerificationRequiredAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."id";
END;
