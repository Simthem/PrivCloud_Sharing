-- CreateTable
CREATE TABLE "OAuthReauthToken" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "stage" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "OAuthReauthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamProfile" (
    "teamId" TEXT NOT NULL PRIMARY KEY,
    "encryptedInfo" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "TeamProfile_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamExternalSeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "inviteExpiresAt" DATETIME NOT NULL,
    "accessExpiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "revokedAt" DATETIME,
    "invitedById" TEXT,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    CONSTRAINT "TeamExternalSeat_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamExternalSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamExternalRevocationWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL DEFAULT 'NONE',
    "notifiedAt" DATETIME,
    "seatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "TeamExternalRevocationWatch_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "TeamExternalSeat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamExternalRevocationWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamExternalPreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "pageCount" INTEGER NOT NULL,
    "deletedAt" DATETIME,
    "encryptedManifest" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "kemCiphertext" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "createdById" TEXT,
    "teamId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "sourceFileId" TEXT,
    CONSTRAINT "TeamExternalPreview_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamExternalPreview_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "TeamExternalSeat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamExternalPreview_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "File" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamExternalPreviewPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "index" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT,
    "previewId" TEXT NOT NULL,
    CONSTRAINT "TeamExternalPreviewPage_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "TeamExternalPreview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamAuditKey" (
    "teamId" TEXT NOT NULL PRIMARY KEY,
    "encryptedKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "TeamAuditKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccountPasskey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "credentialId" TEXT NOT NULL,
    "publicKey" BLOB NOT NULL,
    "publicKeyAlgorithm" INTEGER NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "userId" TEXT NOT NULL,
    CONSTRAINT "AccountPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PasskeyChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "purpose" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "manifest" TEXT,
    "previewId" TEXT,
    "userId" TEXT,
    CONSTRAINT "PasskeyChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamExternalIssuance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "issuedAt" DATETIME,
    "teamId" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "contractorEmail" TEXT NOT NULL,
    "contractorName" TEXT,
    "issuerId" TEXT,
    "issuerEmail" TEXT NOT NULL,
    "markId" TEXT NOT NULL,
    "manifest" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "encryptedLabel" TEXT,
    "credentialId" TEXT NOT NULL,
    "credentialPublicKey" TEXT NOT NULL,
    "credentialAlgorithm" INTEGER NOT NULL,
    "authenticatorData" TEXT NOT NULL,
    "clientDataJSON" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "userHandle" TEXT,
    "recordHash" TEXT NOT NULL,
    "timestampToken" TEXT,
    "timestampedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TeamExternalAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "previewId" TEXT,
    "seatId" TEXT,
    "actorEmail" TEXT NOT NULL,
    "pageIndex" INTEGER,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "TeamExternalAuditAnchor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "teamId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "timestampToken" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "EvidenceVaultSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "EvidenceVaultSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OAuthReauthToken_userId_stage_idx" ON "OAuthReauthToken"("userId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalSeat_tokenHash_key" ON "TeamExternalSeat"("tokenHash");

-- CreateIndex
CREATE INDEX "TeamExternalSeat_userId_status_idx" ON "TeamExternalSeat"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalSeat_teamId_email_key" ON "TeamExternalSeat"("teamId", "email");

-- CreateIndex
CREATE INDEX "TeamExternalRevocationWatch_notifiedAt_mode_idx" ON "TeamExternalRevocationWatch"("notifiedAt", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalRevocationWatch_seatId_userId_key" ON "TeamExternalRevocationWatch"("seatId", "userId");

-- CreateIndex
CREATE INDEX "TeamExternalPreview_seatId_status_idx" ON "TeamExternalPreview"("seatId", "status");

-- CreateIndex
CREATE INDEX "TeamExternalPreview_teamId_createdAt_idx" ON "TeamExternalPreview"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamExternalPreview_sourceFileId_idx" ON "TeamExternalPreview"("sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalPreviewPage_previewId_index_key" ON "TeamExternalPreviewPage"("previewId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPasskey_credentialId_key" ON "AccountPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "AccountPasskey_userId_idx" ON "AccountPasskey"("userId");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_userId_purpose_idx" ON "PasskeyChallenge"("userId", "purpose");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_expiresAt_idx" ON "PasskeyChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalIssuance_previewId_key" ON "TeamExternalIssuance"("previewId");

-- CreateIndex
CREATE INDEX "TeamExternalIssuance_teamId_createdAt_idx" ON "TeamExternalIssuance"("teamId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalIssuance_teamId_markId_key" ON "TeamExternalIssuance"("teamId", "markId");

-- CreateIndex
CREATE INDEX "TeamExternalAuditEvent_teamId_previewId_idx" ON "TeamExternalAuditEvent"("teamId", "previewId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamExternalAuditEvent_teamId_seq_key" ON "TeamExternalAuditEvent"("teamId", "seq");

-- CreateIndex
CREATE INDEX "TeamExternalAuditAnchor_teamId_seq_idx" ON "TeamExternalAuditAnchor"("teamId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceVaultSession_sessionHash_key" ON "EvidenceVaultSession"("sessionHash");

-- CreateIndex
CREATE INDEX "EvidenceVaultSession_userId_idx" ON "EvidenceVaultSession"("userId");

-- CreateIndex
CREATE INDEX "EvidenceVaultSession_expiresAt_idx" ON "EvidenceVaultSession"("expiresAt");
