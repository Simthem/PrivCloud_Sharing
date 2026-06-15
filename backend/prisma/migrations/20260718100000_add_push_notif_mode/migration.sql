-- Add per-member team push notification preference.
ALTER TABLE "TeamMember" ADD COLUMN "pushNotifMode" TEXT NOT NULL DEFAULT 'EVERY_FILE';
