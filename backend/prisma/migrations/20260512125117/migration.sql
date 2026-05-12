/*
  Warnings:

  - You are about to drop the `DownloadEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Subscription` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WrappedKey` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `lastDownloadNotifSentAt` on the `Share` table. All the data in the column will be lost.
  - You are about to drop the column `notifyOnDownload` on the `Share` table. All the data in the column will be lost.
  - You are about to drop the column `notificationMode` on the `User` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Subscription_userId_key";

-- DropIndex
DROP INDEX "Subscription_stripeSubscriptionId_key";

-- DropIndex
DROP INDEX "Subscription_stripeCustomerId_key";

-- DropIndex
DROP INDEX "WrappedKey_userId_credentialId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "DownloadEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Subscription";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "WrappedKey";
PRAGMA foreign_keys=on;

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
