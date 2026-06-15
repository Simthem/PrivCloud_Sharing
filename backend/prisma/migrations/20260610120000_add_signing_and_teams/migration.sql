-- CreateTable: SignatureDocument (consolidated — includes all columns)
CREATE TABLE "SignatureDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "fileName" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "fileKey" TEXT NOT NULL DEFAULT '',
    "originalFileKey" TEXT NOT NULL,
    "signedFileKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "signatureLevel" TEXT NOT NULL DEFAULT 'AES',
    "expiresAt" DATETIME,
    "addApprovalMention" BOOLEAN NOT NULL DEFAULT true,
    "addApprovalField" BOOLEAN NOT NULL DEFAULT true,
    "addInitials" BOOLEAN NOT NULL DEFAULT false,
    "isE2EEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL DEFAULT '',
    "creatorId" TEXT NOT NULL,
    "shareId" TEXT,
    "fileId" TEXT,
    "teamId" TEXT,
    CONSTRAINT "SignatureDocument_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SignatureDocument_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable: SignatureRecipient
CREATE TABLE "SignatureRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "signingToken" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SIGNER',
    "order" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signedAt" DATETIME,
    "rejectionReason" TEXT,
    "signatureData" TEXT,
    "signatureType" TEXT,
    "otpHash" TEXT,
    "otpSentAt" DATETIME,
    "otpVerified" BOOLEAN NOT NULL DEFAULT false,
    "otpFailures" INTEGER NOT NULL DEFAULT 0,
    "signingIp" TEXT,
    "signingUserAgent" TEXT,
    "userId" TEXT,
    "documentId" TEXT NOT NULL,
    CONSTRAINT "SignatureRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SignatureRecipient_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SignatureDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: SignatureField
CREATE TABLE "SignatureField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'SIGNATURE',
    "page" INTEGER NOT NULL,
    "posX" REAL NOT NULL,
    "posY" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "rotation" REAL NOT NULL DEFAULT 0,
    "label" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "documentId" TEXT NOT NULL,
    "assignedRecipientId" TEXT,
    CONSTRAINT "SignatureField_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SignatureDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: SignatureFieldValue
CREATE TABLE "SignatureFieldValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    CONSTRAINT "SignatureFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "SignatureField" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SignatureFieldValue_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "SignatureRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: SignatureAuditEvent
CREATE TABLE "SignatureAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" TEXT,
    "documentId" TEXT NOT NULL,
    CONSTRAINT "SignatureAuditEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SignatureDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: SigningCertificate
CREATE TABLE "SigningCertificate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "certificateData" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "subject" TEXT,
    "validFrom" DATETIME,
    "validUntil" DATETIME,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "tsaUrl" TEXT
);

-- CreateTable: Team
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "avatarKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxMembers" INTEGER NOT NULL DEFAULT 0,
    "maxShareSize" BIGINT NOT NULL DEFAULT 0,
    "totalStorageLimit" BIGINT NOT NULL DEFAULT 0,
    "storageUsed" BIGINT NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "reportFrequency" TEXT NOT NULL DEFAULT 'WEEKLY',
    CONSTRAINT "Team_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamMember
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamFolder
CREATE TABLE "TeamFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "storagePrefix" TEXT NOT NULL,
    "color" TEXT,
    "teamId" TEXT NOT NULL,
    CONSTRAINT "TeamFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TeamFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFolder_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamFolderAccess
CREATE TABLE "TeamFolderAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "permission" TEXT NOT NULL DEFAULT 'READ',
    "memberId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    CONSTRAINT "TeamFolderAccess_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamFolderAccess_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamFile
CREATE TABLE "TeamFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mimeType" TEXT,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "folderId" TEXT NOT NULL,
    CONSTRAINT "TeamFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamAccessLog
CREATE TABLE "TeamAccessLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "actorName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "fileName" TEXT,
    "fileSize" BIGINT,
    "teamId" TEXT NOT NULL,
    "folderId" TEXT,
    "fileId" TEXT,
    CONSTRAINT "TeamAccessLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamAccessLog_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamAccessLog_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "TeamFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable: TeamInvitation
CREATE TABLE "TeamInvitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" DATETIME NOT NULL,
    "teamId" TEXT NOT NULL,
    CONSTRAINT "TeamInvitation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: TeamGuestLink
CREATE TABLE "TeamGuestLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "permission" TEXT NOT NULL DEFAULT 'READ',
    "passwordHash" TEXT,
    "maxDownloads" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "folderId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamGuestLink_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "TeamFolder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamGuestLink_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamGuestLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "TeamMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: Signature indexes
CREATE UNIQUE INDEX "SignatureRecipient_signingToken_key" ON "SignatureRecipient"("signingToken");
CREATE UNIQUE INDEX "SignatureFieldValue_fieldId_recipientId_key" ON "SignatureFieldValue"("fieldId", "recipientId");

-- CreateIndex: Team indexes
CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");
CREATE UNIQUE INDEX "TeamMember_userId_teamId_key" ON "TeamMember"("userId", "teamId");
CREATE UNIQUE INDEX "TeamFolderAccess_memberId_folderId_key" ON "TeamFolderAccess"("memberId", "folderId");
CREATE UNIQUE INDEX "TeamInvitation_token_key" ON "TeamInvitation"("token");
CREATE UNIQUE INDEX "TeamInvitation_email_teamId_key" ON "TeamInvitation"("email", "teamId");
CREATE UNIQUE INDEX "TeamGuestLink_token_key" ON "TeamGuestLink"("token");
CREATE INDEX "TeamGuestLink_teamId_idx" ON "TeamGuestLink"("teamId");
CREATE INDEX "TeamGuestLink_folderId_idx" ON "TeamGuestLink"("folderId");
