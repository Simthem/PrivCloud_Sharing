-- FILE_META_V1 extended: encrypted share title and description, and encrypted
-- file names for Team folder uploads (K_team) and reverse-share uploads
-- (K_rs). Additive only. Every existing row keeps NULL in the new column and
-- satisfies the new triggers. No existing data is rewritten.
ALTER TABLE "Share" ADD COLUMN "encryptedInfo" TEXT;

-- Encrypted names need a key that the server never holds and that no
-- K_master rotation rewrites: any E2E share except LEGACY_ACCOUNT_KEY (1).
-- The application additionally ties each case to its own flag. Triggers
-- stand in for CHECK constraints, and IS NOT keeps a NULL cryptoScheme valid.
DROP TRIGGER "Share_fileMetadataScheme_check_insert";
DROP TRIGGER "Share_fileMetadataScheme_check_update";

CREATE TRIGGER "Share_fileMetadataScheme_check_insert"
BEFORE INSERT ON "Share"
WHEN NOT (
  NEW."fileMetadataScheme" IS NULL
  OR (
    NEW."fileMetadataScheme" IS 1
    AND NEW."isE2EEncrypted" = true
    AND NEW."cryptoScheme" IS NOT 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.fileMetadataScheme requires an E2E share without LEGACY_ACCOUNT_KEY');
END;

CREATE TRIGGER "Share_fileMetadataScheme_check_update"
BEFORE UPDATE OF "fileMetadataScheme", "cryptoScheme", "isE2EEncrypted" ON "Share"
WHEN NOT (
  NEW."fileMetadataScheme" IS NULL
  OR (
    NEW."fileMetadataScheme" IS 1
    AND NEW."isE2EEncrypted" = true
    AND NEW."cryptoScheme" IS NOT 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.fileMetadataScheme requires an E2E share without LEGACY_ACCOUNT_KEY');
END;

-- An encrypted title only exists on a share with encrypted names, and never
-- next to a readable title or description.
CREATE TRIGGER "Share_encryptedInfo_check_insert"
BEFORE INSERT ON "Share"
WHEN NOT (
  NEW."encryptedInfo" IS NULL
  OR (
    NEW."fileMetadataScheme" IS 1
    AND NEW."name" IS NULL
    AND NEW."description" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.encryptedInfo requires encrypted names and no readable title');
END;

CREATE TRIGGER "Share_encryptedInfo_check_update"
BEFORE UPDATE OF "encryptedInfo", "fileMetadataScheme", "name", "description" ON "Share"
WHEN NOT (
  NEW."encryptedInfo" IS NULL
  OR (
    NEW."fileMetadataScheme" IS 1
    AND NEW."name" IS NULL
    AND NEW."description" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Share.encryptedInfo requires encrypted names and no readable title');
END;
