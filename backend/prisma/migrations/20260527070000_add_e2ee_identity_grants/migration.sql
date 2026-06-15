-- CreateTable: UserIdentityKey (X25519 + Ed25519 per-user key pairs)
CREATE TABLE "UserIdentityKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "keyType" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'x25519',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    CONSTRAINT "UserIdentityKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: AccessGrant (encrypted DEK per user - capability-based E2EE)
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "encryptedFileKey" TEXT NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'x25519-aes256gcm',
    "dekVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" DATETIME,
    "grantorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileId" TEXT,
    "teamFileId" TEXT,
    "shareId" TEXT,
    CONSTRAINT "AccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccessGrant_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccessGrant_teamFileId_fkey" FOREIGN KEY ("teamFileId") REFERENCES "TeamFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccessGrant_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: EnrollmentToken (one-time identity bootstrap)
CREATE TABLE "EnrollmentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "metadata" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "usedAt" DATETIME,
    "usedById" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "creatorId" TEXT NOT NULL,
    "teamId" TEXT
);

-- CreateTable: TeamNotification (team file sharing notifications)
CREATE TABLE "TeamNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metadata" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamFileId" TEXT,
    "folderId" TEXT,
    "actorId" TEXT,
    CONSTRAINT "TeamNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_teamFileId_fkey" FOREIGN KEY ("teamFileId") REFERENCES "TeamFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamNotification_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable: UserPQKey (ML-KEM post-quantum key encapsulation)
CREATE TABLE "UserPQKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "variant" TEXT NOT NULL DEFAULT 'ML-KEM-768',
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT NOT NULL,
    CONSTRAINT "UserPQKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentityKey_userId_keyType_version_key" ON "UserIdentityKey"("userId", "keyType", "version");
CREATE INDEX "UserIdentityKey_userId_keyType_isActive_idx" ON "UserIdentityKey"("userId", "keyType", "isActive");

CREATE INDEX "AccessGrant_userId_status_idx" ON "AccessGrant"("userId", "status");
CREATE INDEX "AccessGrant_fileId_status_idx" ON "AccessGrant"("fileId", "status");
CREATE INDEX "AccessGrant_teamFileId_status_idx" ON "AccessGrant"("teamFileId", "status");
CREATE INDEX "AccessGrant_shareId_status_idx" ON "AccessGrant"("shareId", "status");
CREATE INDEX "AccessGrant_userId_fileId_dekVersion_idx" ON "AccessGrant"("userId", "fileId", "dekVersion");

CREATE UNIQUE INDEX "EnrollmentToken_token_key" ON "EnrollmentToken"("token");
CREATE INDEX "EnrollmentToken_token_idx" ON "EnrollmentToken"("token");
CREATE INDEX "EnrollmentToken_teamId_status_idx" ON "EnrollmentToken"("teamId", "status");

CREATE INDEX "TeamNotification_userId_isRead_idx" ON "TeamNotification"("userId", "isRead");
CREATE INDEX "TeamNotification_teamId_createdAt_idx" ON "TeamNotification"("teamId", "createdAt");
CREATE INDEX "TeamNotification_userId_teamId_idx" ON "TeamNotification"("userId", "teamId");

CREATE UNIQUE INDEX "UserPQKey_userId_version_key" ON "UserPQKey"("userId", "version");
CREATE INDEX "UserPQKey_userId_isActive_idx" ON "UserPQKey"("userId", "isActive");
