-- SHARE_DEK_V1: per-share random key wrapped by the owner's account key.
-- Additive only. Every existing row keeps NULL in the four new columns, which
-- the application reads as LEGACY_ACCOUNT_KEY. No existing data is rewritten.
ALTER TABLE "Share" ADD COLUMN "cryptoScheme" INTEGER;
ALTER TABLE "Share" ADD COLUMN "wrappedShareKey" TEXT;
ALTER TABLE "Share" ADD COLUMN "wrappedShareKeyAlgorithm" TEXT;
ALTER TABLE "Share" ADD COLUMN "wrappedShareKeyVersion" INTEGER;

-- SQLite cannot add a CHECK constraint to an existing table: the same rules
-- are enforced by triggers. A SHARE_DEK_V1 row without its wrapped key could
-- never be opened by its owner, and a wrapped key on any other row would be
-- ambiguous. IS compares NULL safely, so a NULL cryptoScheme never slips
-- through. Existing rows all hold NULL in the new columns and are compliant.
CREATE TRIGGER "Share_cryptoScheme_check_insert"
BEFORE INSERT ON "Share"
WHEN NOT (
  NEW."cryptoScheme" IS NULL
  OR NEW."cryptoScheme" IN (1, 2)
)
BEGIN
  SELECT RAISE(ABORT, 'Share.cryptoScheme is not a known scheme');
END;

CREATE TRIGGER "Share_cryptoScheme_check_update"
BEFORE UPDATE OF "cryptoScheme" ON "Share"
WHEN NOT (
  NEW."cryptoScheme" IS NULL
  OR NEW."cryptoScheme" IN (1, 2)
)
BEGIN
  SELECT RAISE(ABORT, 'Share.cryptoScheme is not a known scheme');
END;

CREATE TRIGGER "Share_wrappedShareKey_check_insert"
BEFORE INSERT ON "Share"
WHEN NOT (
  (
    NEW."cryptoScheme" IS 2
    AND NEW."isE2EEncrypted" = true
    AND NEW."wrappedShareKey" IS NOT NULL
    AND NEW."wrappedShareKeyAlgorithm" IS NOT NULL
    AND NEW."wrappedShareKeyVersion" IS NOT NULL
  )
  OR (
    (NEW."cryptoScheme" IS NULL OR NEW."cryptoScheme" IS 1)
    AND NEW."wrappedShareKey" IS NULL
    AND NEW."wrappedShareKeyAlgorithm" IS NULL
    AND NEW."wrappedShareKeyVersion" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.wrappedShareKey does not match its cryptoScheme');
END;

CREATE TRIGGER "Share_wrappedShareKey_check_update"
BEFORE UPDATE OF
  "cryptoScheme",
  "isE2EEncrypted",
  "wrappedShareKey",
  "wrappedShareKeyAlgorithm",
  "wrappedShareKeyVersion"
ON "Share"
WHEN NOT (
  (
    NEW."cryptoScheme" IS 2
    AND NEW."isE2EEncrypted" = true
    AND NEW."wrappedShareKey" IS NOT NULL
    AND NEW."wrappedShareKeyAlgorithm" IS NOT NULL
    AND NEW."wrappedShareKeyVersion" IS NOT NULL
  )
  OR (
    (NEW."cryptoScheme" IS NULL OR NEW."cryptoScheme" IS 1)
    AND NEW."wrappedShareKey" IS NULL
    AND NEW."wrappedShareKeyAlgorithm" IS NULL
    AND NEW."wrappedShareKeyVersion" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.wrappedShareKey does not match its cryptoScheme');
END;
