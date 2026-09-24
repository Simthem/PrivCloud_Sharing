-- Separate the internal forensic evidence (network data, account identifiers,
-- raw WebAuthn material) from the attestation distributed to the parties.
ALTER TABLE "SignatureRecipient" ADD COLUMN "evidenceId" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN "forensicRecord" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN "forensicRecordSha256" TEXT;
CREATE UNIQUE INDEX "SignatureRecipient_evidenceId_key" ON "SignatureRecipient"("evidenceId");

ALTER TABLE "SignatureDocument" ADD COLUMN "forensicEvidenceKey" TEXT;
ALTER TABLE "SignatureDocument" ADD COLUMN "forensicEvidenceSignatureKey" TEXT;
ALTER TABLE "SignatureDocument" ADD COLUMN "forensicEvidenceSha256" TEXT;
