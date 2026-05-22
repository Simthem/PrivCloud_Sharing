-- Add isE2EEncrypted flag to SignatureDocument for client-side finalization
ALTER TABLE "SignatureDocument" ADD COLUMN "isE2EEncrypted" BOOLEAN NOT NULL DEFAULT false;
