-- Add optional client-encrypted notification metadata.
ALTER TABLE "TeamNotification" ADD COLUMN "encryptedMetadata" TEXT;
