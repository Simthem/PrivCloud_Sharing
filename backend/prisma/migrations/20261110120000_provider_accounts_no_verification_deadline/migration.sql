-- Accounts reached through an identity provider are not removed for an unconfirmed address.
UPDATE "User"
SET "emailVerificationRequiredAt" = NULL
WHERE "emailVerifiedAt" IS NULL
  AND "emailVerificationRequiredAt" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "OAuthUser" WHERE "OAuthUser"."userId" = "User"."id");
