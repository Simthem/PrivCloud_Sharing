-- Rights granted or refused to a member who left must not come back with them.
DELETE FROM "FileAccess"
WHERE "memberId" IN (SELECT "id" FROM "TeamMember" WHERE "isActive" = 0);

DELETE FROM "TeamFolderAccess"
WHERE "memberId" IN (SELECT "id" FROM "TeamMember" WHERE "isActive" = 0);
