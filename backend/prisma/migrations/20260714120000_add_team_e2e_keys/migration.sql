-- E2E encryption keys for team collaboration.
-- K_team is wrapped per-member by their personal K_user.

-- TeamMember: store K_team wrapped by each member's K_user
ALTER TABLE "TeamMember" ADD COLUMN "wrappedTeamKey" TEXT;

-- TeamInvitation: transport K_team encrypted for the invitee
ALTER TABLE "TeamInvitation" ADD COLUMN "encryptedTeamKey" TEXT;
