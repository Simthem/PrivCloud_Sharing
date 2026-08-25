-- Keep the public Share.id capability out of administration responses.
ALTER TABLE "Share" ADD COLUMN "adminAuditId" TEXT;

UPDATE "Share"
SET "adminAuditId" =
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE "adminAuditId" IS NULL;

CREATE UNIQUE INDEX "Share_adminAuditId_key" ON "Share"("adminAuditId");

CREATE TRIGGER "Share_adminAuditId_not_null_insert"
BEFORE INSERT ON "Share"
WHEN NEW."adminAuditId" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Share.adminAuditId must not be null');
END;

CREATE TRIGGER "Share_adminAuditId_not_null_update"
BEFORE UPDATE OF "adminAuditId" ON "Share"
WHEN NEW."adminAuditId" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Share.adminAuditId must not be null');
END;

DELETE FROM "Config"
WHERE "category" = 'share' AND "name" = 'allowAdminAccessAllShares';
