-- A single live token per account meant that every resend revoked the link of
-- the message already on its way. With a slow relay the recipient could end up
-- with several messages whose links were all dead but the last one. Concurrent
-- tokens are now allowed; the application caps how many stay live per account
-- and the hourly job still deletes them once expired.
--
-- The uniqueness was declared as a standalone index, so dropping the index is
-- enough and the table itself does not have to be rebuilt.
DROP INDEX IF EXISTS "EmailVerificationToken_userId_key";

CREATE INDEX IF NOT EXISTS "EmailVerificationToken_userId_idx"
  ON "EmailVerificationToken"("userId");
