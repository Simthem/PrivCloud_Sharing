-- CreateTable
CREATE TABLE "TotpBackupCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "userId" TEXT NOT NULL,
    CONSTRAINT "TotpBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
