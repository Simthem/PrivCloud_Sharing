-- Distinguish explicit E2E key deletion from a never-configured account.
ALTER TABLE "User"
ADD COLUMN "e2eAutoGenerationDisabledAt" DATETIME;

-- Existing accounts with encrypted shares and no registered key are treated
-- conservatively: automatic replacement stays disabled until explicit setup.
UPDATE "User"
SET "e2eAutoGenerationDisabledAt" = CURRENT_TIMESTAMP
WHERE "encryptionKeyHash" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "Share"
    WHERE "Share"."creatorId" = "User"."id"
      AND "Share"."isE2EEncrypted" = 1
  );
