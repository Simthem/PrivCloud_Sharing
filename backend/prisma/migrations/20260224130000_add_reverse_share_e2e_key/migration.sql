-- AlterTable: add encrypted reverse share key for E2E encryption of reverse share uploads
-- K_rs is encrypted with the owner's master key (K_master) and stored as base64url.
-- The server never sees K_rs in cleartext.
ALTER TABLE "ReverseShare" ADD COLUMN "encryptedReverseShareKey" TEXT;
