CREATE TABLE "StepUpGrant" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "usedAt" DATETIME,
  "scope" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "StepUpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StepUpGrant_expiresAt_idx" ON "StepUpGrant"("expiresAt");
ALTER TABLE "SignatureRecipient" ADD COLUMN "otpSessionHash" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN "otpSessionExpiresAt" DATETIME;
