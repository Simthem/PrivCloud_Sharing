CREATE TABLE "EmailChangeRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "oldEmail" TEXT NOT NULL,
  "newEmail" TEXT NOT NULL,
  "securityState" TEXT NOT NULL,
  "oldTokenHash" TEXT NOT NULL,
  "newTokenHash" TEXT NOT NULL,
  "cancelTokenHash" TEXT NOT NULL,
  "oldApprovedAt" DATETIME,
  "newVerifiedAt" DATETIME,
  "expiresAt" DATETIME NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailChangeRequest_userId_key" ON "EmailChangeRequest"("userId");
CREATE UNIQUE INDEX "EmailChangeRequest_oldTokenHash_key" ON "EmailChangeRequest"("oldTokenHash");
CREATE UNIQUE INDEX "EmailChangeRequest_newTokenHash_key" ON "EmailChangeRequest"("newTokenHash");
CREATE UNIQUE INDEX "EmailChangeRequest_cancelTokenHash_key" ON "EmailChangeRequest"("cancelTokenHash");
CREATE INDEX "EmailChangeRequest_expiresAt_idx" ON "EmailChangeRequest"("expiresAt");
