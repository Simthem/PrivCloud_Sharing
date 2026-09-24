-- Daily Trusted List check of the pinned qualified TSA.
CREATE TABLE "TrustedListCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listUrl" TEXT NOT NULL,
    "listSha256" TEXT,
    "sequenceNumber" TEXT,
    "nextUpdate" DATETIME,
    "result" TEXT NOT NULL,
    "trace" TEXT NOT NULL
);

CREATE INDEX "TrustedListCheck_checkedAt_idx" ON "TrustedListCheck"("checkedAt");
