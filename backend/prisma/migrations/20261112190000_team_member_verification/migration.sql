ALTER TABLE "User" ADD COLUMN "teamVerificationMailedAt" DATETIME;

-- Team members are never blocked or deleted for an unverified address.
UPDATE "User"
SET "emailVerificationRequiredAt" = NULL
WHERE "emailVerifiedAt" IS NULL
  AND "emailVerificationDeletionStartedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "TeamMember"
    WHERE "TeamMember"."userId" = "User"."id" AND "TeamMember"."isActive"
  );

-- Same rule for any account that joins a team later, whatever the code path.
CREATE TRIGGER "TeamMember_exempt_email_deadline_on_insert"
AFTER INSERT ON "TeamMember"
FOR EACH ROW
WHEN NEW."isActive"
BEGIN
  UPDATE "User"
  SET "emailVerificationRequiredAt" = NULL
  WHERE "id" = NEW."userId"
    AND "emailVerificationRequiredAt" IS NOT NULL
    AND "emailVerifiedAt" IS NULL
    AND "emailVerificationDeletionStartedAt" IS NULL;
END;

CREATE TRIGGER "TeamMember_exempt_email_deadline_on_update"
AFTER UPDATE OF "isActive" ON "TeamMember"
FOR EACH ROW
WHEN NEW."isActive"
BEGIN
  UPDATE "User"
  SET "emailVerificationRequiredAt" = NULL
  WHERE "id" = NEW."userId"
    AND "emailVerificationRequiredAt" IS NOT NULL
    AND "emailVerifiedAt" IS NULL
    AND "emailVerificationDeletionStartedAt" IS NULL;
END;
