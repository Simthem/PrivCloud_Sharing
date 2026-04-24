-- CreateTable
CREATE TABLE "DownloadEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byRegisteredUser" BOOLEAN NOT NULL DEFAULT false,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "shareId" TEXT NOT NULL,
    CONSTRAINT "DownloadEvent_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Share" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "uploadLocked" BOOLEAN NOT NULL DEFAULT false,
    "isZipReady" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "expiration" DATETIME NOT NULL,
    "description" TEXT,
    "removedReason" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "notifyOnDownload" BOOLEAN NOT NULL DEFAULT false,
    "lastDownloadNotifSentAt" DATETIME,
    "creatorId" TEXT,
    "reverseShareId" TEXT,
    "storageProvider" TEXT NOT NULL DEFAULT 'LOCAL',
    "isE2EEncrypted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Share_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Share_reverseShareId_fkey" FOREIGN KEY ("reverseShareId") REFERENCES "ReverseShare" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Share" ("createdAt", "creatorId", "description", "expiration", "id", "isE2EEncrypted", "isZipReady", "name", "removedReason", "reverseShareId", "senderEmail", "senderName", "storageProvider", "uploadLocked", "views") SELECT "createdAt", "creatorId", "description", "expiration", "id", "isE2EEncrypted", "isZipReady", "name", "removedReason", "reverseShareId", "senderEmail", "senderName", "storageProvider", "uploadLocked", "views" FROM "Share";
DROP TABLE "Share";
ALTER TABLE "new_Share" RENAME TO "Share";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "ldapDN" TEXT,
    "notificationMode" TEXT NOT NULL DEFAULT 'DIGEST',
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpVerified" BOOLEAN NOT NULL DEFAULT false,
    "totpSecret" TEXT,
    "encryptionKeyHash" TEXT
);
INSERT INTO "new_User" ("createdAt", "email", "encryptionKeyHash", "id", "isAdmin", "ldapDN", "password", "totpEnabled", "totpSecret", "totpVerified", "updatedAt", "username") SELECT "createdAt", "email", "encryptionKeyHash", "id", "isAdmin", "ldapDN", "password", "totpEnabled", "totpSecret", "totpVerified", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_ldapDN_key" ON "User"("ldapDN");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
