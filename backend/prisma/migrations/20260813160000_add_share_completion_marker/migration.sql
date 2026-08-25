-- Durable upload lifecycle state used by resumable transfers and cleanup.
ALTER TABLE "Share" ADD COLUMN "uploadLastActivityAt" DATETIME;
ALTER TABLE "Share" ADD COLUMN "uploadCleanupStartedAt" DATETIME;
ALTER TABLE "Share" ADD COLUMN "hasBeenCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Share" ADD COLUMN "anonymousSessionToken" TEXT;

UPDATE "Share"
SET "uploadLastActivityAt" = "createdAt",
    -- Preserve every pre-upgrade share conservatively. A share that happened to
    -- be open for editing during the upgrade may have uploadLocked=false while
    -- still owning completed files; treating it as new could delete user data.
    "hasBeenCompleted" = true;

CREATE TRIGGER "preserveShareCompletionAfterInsert"
AFTER INSERT ON "Share"
WHEN NEW."uploadLocked" = true AND NEW."hasBeenCompleted" = false
BEGIN
  UPDATE "Share" SET "hasBeenCompleted" = true WHERE "id" = NEW."id";
END;

CREATE TRIGGER "preserveShareCompletionAfterUpdate"
AFTER UPDATE OF "uploadLocked", "hasBeenCompleted" ON "Share"
WHEN (NEW."uploadLocked" = true OR OLD."hasBeenCompleted" = true)
  AND NEW."hasBeenCompleted" = false
BEGIN
  UPDATE "Share" SET "hasBeenCompleted" = true WHERE "id" = NEW."id";
END;

CREATE INDEX "Share_unfinished_upload_cleanup_idx"
ON "Share"(
  "uploadLocked",
  "hasBeenCompleted",
  "uploadCleanupStartedAt",
  "uploadLastActivityAt"
);
