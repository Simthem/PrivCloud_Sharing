-- CreateTable
CREATE TABLE "WrappedKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credentialId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "WrappedKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WrappedKey_userId_credentialId_key" ON "WrappedKey"("userId", "credentialId");
