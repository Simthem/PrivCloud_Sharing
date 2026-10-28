import "reflect-metadata";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team share access");

type FolderRule = {
  memberId: string;
  folderId: string;
  permission: string;
  canDownload: boolean;
};

type FileRule = { memberId: string; fileId: string; permission: string };

const user = { id: "user-1" };
const members = [
  { id: "member-1", userId: "user-1", teamId: "team-1", isActive: true },
  { id: "member-2", userId: "user-2", teamId: "team-1", isActive: true },
].map((member) => ({ ...member, role: "MEMBER" }));
const teamShare = {
  id: "share-1",
  isE2EEncrypted: false,
  teamFolderId: "folder-1",
  teamFolder: { id: "folder-1", teamId: "team-1" },
  files: [{ id: "file-1" }],
};

const createService = (
  folderRules: FolderRule[] = [],
  fileRules: FileRule[] = [],
) => {
  const prisma = {
    share: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === teamShare.id ? teamShare : null,
    },
    file: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "file-1" ? { id: "file-1", share: teamShare } : null,
    },
    teamMember: {
      findUnique: async ({
        where,
      }: {
        where: { userId_teamId: { userId: string; teamId: string } };
      }) =>
        members.find(
          (member) =>
            member.userId === where.userId_teamId.userId &&
            member.teamId === where.userId_teamId.teamId,
        ) ?? null,
    },
    teamKeyRotation: { findFirst: async () => null },
    teamFolderAccess: {
      findUnique: async ({
        where,
      }: {
        where: { memberId_folderId: { memberId: string; folderId: string } };
      }) =>
        folderRules.find(
          (rule) =>
            rule.memberId === where.memberId_folderId.memberId &&
            rule.folderId === where.memberId_folderId.folderId,
        ) ?? null,
      count: async ({ where }: { where: { folderId: string } }) =>
        folderRules.filter((rule) => rule.folderId === where.folderId).length,
    },
    fileAccess: {
      findUnique: async ({
        where,
      }: {
        where: { memberId_fileId: { memberId: string; fileId: string } };
      }) =>
        fileRules.find(
          (rule) =>
            rule.memberId === where.memberId_fileId.memberId &&
            rule.fileId === where.memberId_fileId.fileId,
        ) ?? null,
      count: async () => 0,
    },
  };

  return new TeamShareAccessService(prisma as never);
};

const otherMemberRule: FolderRule = {
  memberId: "member-2",
  folderId: "folder-1",
  permission: "READ",
  canDownload: true,
};

testCase("members without a rule open an unrestricted folder", async () => {
  const service = createService();

  await service.assertCanAccessShare("share-1", user as never);
  await service.assertCanAccessFile("share-1", "file-1", user as never);
});

testCase("members without a rule are denied a restricted folder", async () => {
  const service = createService([otherMemberRule]);

  await assert.rejects(
    () => service.assertCanAccessShare("share-1", user as never),
    ForbiddenException,
  );
  await assert.rejects(
    () => service.assertCanAccessFile("share-1", "file-1", user as never),
    ForbiddenException,
  );
});

testCase("a member keeps the access of their own rule", async () => {
  const service = createService([
    otherMemberRule,
    { ...otherMemberRule, memberId: "member-1" },
  ]);

  await service.assertCanAccessShare("share-1", user as never);
  await service.assertCanAccessFile("share-1", "file-1", user as never);
});

testCase("an explicit file rule opens that file only", async () => {
  const service = createService(
    [otherMemberRule],
    [{ memberId: "member-1", fileId: "file-1", permission: "READ" }],
  );

  await service.assertCanAccessFile("share-1", "file-1", user as never);
  await assert.rejects(
    () => service.assertCanAccessShare("share-1", user as never),
    ForbiddenException,
  );
});

void run();
