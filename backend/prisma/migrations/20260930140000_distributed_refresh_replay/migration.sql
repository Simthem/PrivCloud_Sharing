CREATE TABLE "RefreshTokenReplay" (
    "previousTokenHash" TEXT NOT NULL PRIMARY KEY,
    "encryptedResult" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

CREATE INDEX "RefreshTokenReplay_expiresAt_idx"
ON "RefreshTokenReplay"("expiresAt");
