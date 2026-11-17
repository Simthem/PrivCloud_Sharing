-- Accounts created through a sign-in provider that could not prove the address
-- were given a verification deadline by the insert trigger, but no link was
-- ever mailed to them. They return to the exemption they were created with.
UPDATE "User"
SET "emailVerificationRequiredAt" = NULL
WHERE "emailVerificationRequiredAt" IS NOT NULL
  AND "emailVerifiedAt" IS NULL
  AND "emailVerificationDeletionStartedAt" IS NULL
  AND "password" IS NULL
  AND "ldapDN" IS NULL
  AND EXISTS (SELECT 1 FROM "OAuthUser" WHERE "OAuthUser"."userId" = "User"."id")
  AND NOT EXISTS (
    SELECT 1 FROM "EmailVerificationToken"
    WHERE "EmailVerificationToken"."userId" = "User"."id"
  );
