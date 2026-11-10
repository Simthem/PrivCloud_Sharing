ALTER TABLE "User" ADD COLUMN "signaturePushEnabled" BOOLEAN NOT NULL DEFAULT false;

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TeamNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metadata" TEXT,
    "encryptedMetadata" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "teamFileId" TEXT,
    "folderId" TEXT,
    "actorId" TEXT,
    CONSTRAINT "TeamNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_teamFileId_fkey" FOREIGN KEY ("teamFileId") REFERENCES "TeamFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TeamNotification" ("id", "createdAt", "type", "title", "metadata", "encryptedMetadata", "isRead", "userId", "teamId", "teamFileId", "folderId", "actorId")
SELECT "id", "createdAt", "type", "title", "metadata", "encryptedMetadata", "isRead", "userId", "teamId", "teamFileId", "folderId", "actorId" FROM "TeamNotification";
DROP TABLE "TeamNotification";
ALTER TABLE "new_TeamNotification" RENAME TO "TeamNotification";
CREATE INDEX "TeamNotification_userId_isRead_idx" ON "TeamNotification"("userId", "isRead");
CREATE INDEX "TeamNotification_teamId_createdAt_idx" ON "TeamNotification"("teamId", "createdAt");
CREATE INDEX "TeamNotification_userId_teamId_idx" ON "TeamNotification"("userId", "teamId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
