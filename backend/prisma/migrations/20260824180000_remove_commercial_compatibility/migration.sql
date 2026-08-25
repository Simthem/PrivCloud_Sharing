-- The open-source edition exposes the complete feature set to every user.
-- Remove the legacy compatibility table that carried unused plan metadata.
PRAGMA foreign_keys=OFF;
DROP INDEX IF EXISTS "Subscription_userId_key";
DROP TABLE IF EXISTS "Subscription";
PRAGMA foreign_keys=ON;
