import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export function canWriteRequestFolder(
  member: { id: string; role: string; isActive: boolean } | undefined,
  rules: Array<{ memberId: string; permission: string }>,
): boolean {
  return (
    !!member?.isActive &&
    (["OWNER", "ADMIN"].includes(member.role) ||
      rules.some(
        (rule) =>
          rule.memberId === member.id &&
          ["WRITE", "ADMIN"].includes(rule.permission),
      ))
  );
}

/** Whoever can read a folder can ask for files in it: uploaders need write. */
export function canReadRequestFolder(
  member: { id: string; role: string; isActive: boolean } | undefined,
  rules: Array<{ memberId: string; permission: string }>,
): boolean {
  if (!member?.isActive) return false;
  if (["OWNER", "ADMIN"].includes(member.role)) return true;
  const rule = rules.find((candidate) => candidate.memberId === member.id);
  return rule
    ? !["NONE", "DENY"].includes(rule.permission)
    : rules.length === 0;
}

/** Use the share creation or completion transaction. The SQLite writer lock prevents
 * the request from closing while a submission is being completed. */
export async function assertFileRequestUpload(
  tx: Prisma.TransactionClient,
  requestId: string,
  userId: string | undefined,
  folderId: string | undefined | null,
) {
  await tx.$executeRaw`UPDATE "TeamFileRequest" SET "status" = "status" WHERE "id" = ${requestId}`;
  const request = await tx.teamFileRequest.findUnique({
    where: { id: requestId },
    include: {
      recipients: { select: { userId: true } },
      folder: {
        include: { accessRules: true, team: { include: { members: true } } },
      },
    },
  });
  if (
    !request ||
    !userId ||
    !request.recipients.some((r) => r.userId === userId)
  ) {
    throw new NotFoundException("File request not found");
  }
  const folder = request.folder;
  if (
    !folder ||
    folder.id !== folderId ||
    folder.teamId !== request.teamId ||
    !folder.team.isActive ||
    request.status !== "OPEN" ||
    request.expiresAt <= new Date()
  ) {
    throw new ForbiddenException("This file request is no longer available");
  }
  const member = (id: string) =>
    folder.team.members.find((m) => m.userId === id);
  if (
    !canWriteRequestFolder(member(userId), folder.accessRules) ||
    !canReadRequestFolder(member(request.creatorId), folder.accessRules)
  ) {
    throw new ForbiddenException("Write access to the destination is required");
  }
  return request;
}
