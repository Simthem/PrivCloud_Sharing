-- AlterTable: add E2E encryption key hash to User
ALTER TABLE "User" ADD COLUMN "encryptionKeyHash" TEXT;
