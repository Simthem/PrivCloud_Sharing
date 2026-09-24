-- Archive the raw RFC 3161 request and response of every seal timestamp.
CREATE TABLE "SigningTimestamp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageImprint" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "documentId" TEXT,
    "webauthnCredentialId" TEXT,
    "tsaUrl" TEXT NOT NULL,
    "requestBase64" TEXT NOT NULL,
    "responseBase64" TEXT NOT NULL
);

CREATE UNIQUE INDEX "SigningTimestamp_messageImprint_key" ON "SigningTimestamp"("messageImprint");
CREATE INDEX "SigningTimestamp_documentId_idx" ON "SigningTimestamp"("documentId");
CREATE INDEX "SigningTimestamp_webauthnCredentialId_idx" ON "SigningTimestamp"("webauthnCredentialId");
