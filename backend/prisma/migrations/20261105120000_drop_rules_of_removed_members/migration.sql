DELETE FROM "TeamFolderAccess"
WHERE "memberId" IN (SELECT "id" FROM "TeamMember" WHERE "isActive" = false);
