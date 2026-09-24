-- Record how an e-mail address was proven, so an automatic exemption granted
-- without SMTP is never presented as a verified address in signing evidence.
ALTER TABLE "User" ADD COLUMN "emailVerificationSource" TEXT;

-- An automatic exemption stores the same instant in both columns, while a
-- confirmation link is always followed later.
UPDATE "User"
SET "emailVerificationSource" = 'EMAIL_LINK'
WHERE "emailVerifiedAt" IS NOT NULL
  AND "emailVerificationRequiredAt" IS NOT NULL
  AND "emailVerifiedAt" <> "emailVerificationRequiredAt";
