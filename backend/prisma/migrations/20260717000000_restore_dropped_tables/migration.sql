-- Restore columns and tables dropped by 20260512125117
-- These are still used by the application code and schema.

-- Re-add notificationMode to User (dropped by 20260512125117)
ALTER TABLE "User" ADD COLUMN "notificationMode" TEXT NOT NULL DEFAULT 'DIGEST';

-- Re-add download notification columns to Share (dropped by 20260512125117)
ALTER TABLE "Share" ADD COLUMN "notifyOnDownload" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Share" ADD COLUMN "lastDownloadNotifSentAt" DATETIME;

-- Recreate DownloadEvent table (dropped by 20260512125117)
CREATE TABLE IF NOT EXISTS "DownloadEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byRegisteredUser" BOOLEAN NOT NULL DEFAULT false,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "shareId" TEXT NOT NULL,
    CONSTRAINT "DownloadEvent_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Recreate Subscription table (dropped by 20260512125117)
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'TEAM',
    "status" TEXT NOT NULL DEFAULT 'active',
    "userId" TEXT NOT NULL,
    CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Recreate indexes for Subscription
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_userId_key" ON "Subscription"("userId");

-- Recreate WrappedKey table (dropped by 20260512125117)
CREATE TABLE IF NOT EXISTS "WrappedKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credentialId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "WrappedKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Recreate index for WrappedKey
CREATE UNIQUE INDEX IF NOT EXISTS "WrappedKey_userId_credentialId_key" ON "WrappedKey"("userId", "credentialId");
