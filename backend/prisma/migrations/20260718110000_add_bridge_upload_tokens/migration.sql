-- Short-lived bearer tokens used by PrivCloud Bridge to upload chunks into
-- an owner-created share without receiving browser cookies.
CREATE TABLE "BridgeUploadToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "shareId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    CONSTRAINT "BridgeUploadToken_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BridgeUploadToken_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BridgeUploadToken_tokenHash_key" ON "BridgeUploadToken"("tokenHash");
CREATE INDEX "BridgeUploadToken_shareId_idx" ON "BridgeUploadToken"("shareId");
CREATE INDEX "BridgeUploadToken_expiresAt_idx" ON "BridgeUploadToken"("expiresAt");
