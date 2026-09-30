-- FILE_META_V1: file names and folder paths encrypted with K_share.
-- Additive only. Every existing row keeps NULL in the new columns, which the
-- application reads as a plain-text name. No existing data is rewritten.
ALTER TABLE "Share" ADD COLUMN "fileMetadataScheme" INTEGER;
ALTER TABLE "File" ADD COLUMN "metadataScheme" INTEGER;
ALTER TABLE "File" ADD COLUMN "encryptedMetadata" TEXT;

-- Encrypted names need the per-share key: only SHARE_DEK_V1 shares qualify.
-- As in 20260929120000_add_share_dek_v1, triggers stand in for CHECK
-- constraints and IS keeps a NULL cryptoScheme from passing.
CREATE TRIGGER "Share_fileMetadataScheme_check_insert"
BEFORE INSERT ON "Share"
WHEN NOT (
  NEW."fileMetadataScheme" IS NULL
  OR (NEW."fileMetadataScheme" IS 1 AND NEW."cryptoScheme" IS 2)
)
BEGIN
  SELECT RAISE(ABORT, 'Share.fileMetadataScheme requires SHARE_DEK_V1');
END;

CREATE TRIGGER "Share_fileMetadataScheme_check_update"
BEFORE UPDATE OF "fileMetadataScheme", "cryptoScheme" ON "Share"
WHEN NOT (
  NEW."fileMetadataScheme" IS NULL
  OR (NEW."fileMetadataScheme" IS 1 AND NEW."cryptoScheme" IS 2)
)
BEGIN
  SELECT RAISE(ABORT, 'Share.fileMetadataScheme requires SHARE_DEK_V1');
END;

-- An encrypted row carries its ciphertext and nothing readable next to it:
-- the stored name is derived from the file id and the folder path is empty.
CREATE TRIGGER "File_encryptedMetadata_check_insert"
BEFORE INSERT ON "File"
WHEN NOT (
  (NEW."metadataScheme" IS NULL AND NEW."encryptedMetadata" IS NULL)
  OR (
    NEW."metadataScheme" IS 1
    AND NEW."encryptedMetadata" IS NOT NULL
    AND NEW."name" IS ('encrypted-file-' || substr(NEW."id", 1, 8))
    AND NEW."relativePath" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'File.encryptedMetadata requires a neutral name and no path');
END;

CREATE TRIGGER "File_encryptedMetadata_check_update"
BEFORE UPDATE OF
  "id",
  "name",
  "relativePath",
  "metadataScheme",
  "encryptedMetadata"
ON "File"
WHEN NOT (
  (NEW."metadataScheme" IS NULL AND NEW."encryptedMetadata" IS NULL)
  OR (
    NEW."metadataScheme" IS 1
    AND NEW."encryptedMetadata" IS NOT NULL
    AND NEW."name" IS ('encrypted-file-' || substr(NEW."id", 1, 8))
    AND NEW."relativePath" IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'File.encryptedMetadata requires a neutral name and no path');
END;
