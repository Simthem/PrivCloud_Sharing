-- Add authenticated team file requests without rebuilding existing tables.
CREATE TABLE "TeamFileRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "subject" TEXT NOT NULL CHECK (length(trim("subject")) BETWEEN 3 AND 120),
    "note" TEXT CHECK ("note" IS NULL OR length("note") <= 2000),
    "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'CLOSED')),
    "expiresAt" DATETIME NOT NULL,
    "creatorId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "folderId" TEXT,
    "submissionNotification" TEXT,
    "recipientScope" TEXT NOT NULL DEFAULT 'SELECTED' CHECK ("recipientScope" IN ('ALL', 'SELECTED')),
    "sendEmail" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TeamFileRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFileRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFileRequest_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "TeamFileRequestRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "TeamFileRequestRecipient_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "TeamFileRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFileRequestRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "Share" ADD COLUMN "teamFileRequestId" TEXT REFERENCES "TeamFileRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "TeamFileRequest_teamId_createdAt_idx" ON "TeamFileRequest"("teamId", "createdAt");
CREATE INDEX "TeamFileRequest_creatorId_createdAt_idx" ON "TeamFileRequest"("creatorId", "createdAt");
CREATE INDEX "TeamFileRequestRecipient_userId_requestId_idx" ON "TeamFileRequestRecipient"("userId", "requestId");
CREATE UNIQUE INDEX "TeamFileRequestRecipient_requestId_userId_key" ON "TeamFileRequestRecipient"("requestId", "userId");
CREATE INDEX "Share_teamFileRequestId_hasBeenCompleted_creatorId_idx" ON "Share"("teamFileRequestId", "hasBeenCompleted", "creatorId");
