CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deduplicationKey" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "sentAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT
);

CREATE UNIQUE INDEX "EmailOutbox_deduplicationKey_key"
ON "EmailOutbox"("deduplicationKey");
CREATE INDEX "EmailOutbox_sentAt_availableAt_idx"
ON "EmailOutbox"("sentAt", "availableAt");
CREATE INDEX "EmailOutbox_claimedAt_idx" ON "EmailOutbox"("claimedAt");
