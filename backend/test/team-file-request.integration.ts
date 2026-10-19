import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TeamFileRequestService } from "src/teamFileRequest/team-file-request.service";
import { assertFileRequestUpload } from "src/teamFileRequest/team-file-request-access";
import { TeamService } from "src/team/team.service";
import { ShareService } from "src/share/share.service";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { decryptOutboxEmail } from "src/email/email-outbox.crypto";

// Always create a new disposable database; ignore the normal DATABASE_URL.
const fixture = mkdtempSync(path.join(tmpdir(), "privcloud-file-requests-"));
const connectionString = `file:${path.join(fixture, "fixture.db")}`;
writeFileSync(path.join(fixture, "fixture.db"), "");
try {
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: "pipe",
    },
  );
} catch (error) {
  rmSync(fixture, { recursive: true, force: true });
  throw error;
}
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: connectionString }),
});
const envelope = JSON.stringify({
  algorithm: "x25519-aes256gcm",
  ephemeralPublicKey: Buffer.alloc(32, 1).toString("base64url"),
  nonce: Buffer.alloc(12, 2).toString("base64url"),
  ciphertext: Buffer.alloc(32, 3).toString("base64url"),
  kemCiphertext: null,
});
const config = {
  get: (key: string) =>
    ({
      "smtp.enabled": true,
      "general.appUrl": "https://example.test",
      "internal.jwtSecret": "isolated-test-secret",
    })[key],
};
let deliveries = 0;
const notifications = {
  deliverFileRequestNotification: () => {
    deliveries++;
  },
  notifyTeamMembers: async () => {
    throw new Error(
      "Request uploads must not create plaintext team notifications",
    );
  },
};
const outbox = new EmailOutboxService(
  prisma as never,
  config as never,
  {} as never,
);
// Enqueue is exercised, SMTP delivery is deliberately stubbed.
outbox.deliverPending = async () => {};
const service = new TeamFileRequestService(
  prisma as never,
  notifications as never,
  outbox,
  config as never,
);
const users: string[] = [];
const teamIds: string[] = [];

async function main() {
  try {
    const creator = await prisma.user.create({
      data: {
        username: `creator-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
    });
    users.push(creator.id);
    const recipient = await prisma.user.create({
      data: {
        username: `recipient-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
    });
    users.push(recipient.id);
    const quiet = await prisma.user.create({
      data: {
        username: `quiet-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
    });
    users.push(quiet.id);
    const outsider = await prisma.user.create({
      data: {
        username: `outsider-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
    });
    users.push(outsider.id);
    const team = await prisma.team.create({
      data: {
        ownerId: creator.id,
        slug: randomUUID(),
        name: "Fixture",
        members: {
          create: [
            { userId: creator.id, isActive: true, role: "OWNER" },
            { userId: recipient.id, isActive: true },
            { userId: quiet.id, isActive: true, pushNotifMode: "SHARES_ONLY" },
          ],
        },
      },
    });
    teamIds.push(team.id);
    const foreignTeam = await prisma.team.create({
      data: { ownerId: outsider.id, slug: randomUUID(), name: "Foreign" },
    });
    teamIds.push(foreignTeam.id);
    const foreignFolder = await prisma.teamFolder.create({
      data: {
        teamId: foreignTeam.id,
        name: "Foreign",
        storagePrefix: randomUUID(),
      },
    });
    const members = await prisma.teamMember.findMany({
      where: { teamId: team.id },
    });
    const parent = await prisma.teamFolder.create({
      data: { teamId: team.id, name: "Parent", storagePrefix: randomUUID() },
    });
    const folder = await prisma.teamFolder.create({
      data: {
        teamId: team.id,
        parentId: parent.id,
        name: "Destination",
        storagePrefix: randomUUID(),
        accessRules: {
          create: members
            .filter((m) => m.role !== "OWNER")
            .map((m) => ({ memberId: m.id, permission: "WRITE" })),
        },
      },
    });
    const dto = {
      id: randomUUID(),
      folderId: folder.id,
      subject: "Private request subject",
      note: "Private note",
      recipientIds: [recipient.id],
      recipientScope: "ALL" as const,
      sendEmail: true,
      notifications: [{ userId: recipient.id, encryptedMetadata: envelope }],
      submissionNotification: envelope,
    };

    await assert.rejects(
      service.create(team.id, outsider.id, dto),
      NotFoundException,
    );
    await assert.rejects(
      service.create(team.id, creator.id, {
        ...dto,
        folderId: foreignFolder.id,
      }),
      NotFoundException,
    );
    await assert.rejects(
      service.create(team.id, creator.id, {
        ...dto,
        recipientScope: "SELECTED",
        recipientIds: [outsider.id],
      }),
      BadRequestException,
    );
    await assert.rejects(
      service.create(team.id, creator.id, { ...dto, notifications: [] }),
      BadRequestException,
    );
    const result = await service.create(team.id, creator.id, dto);
    const request = await prisma.teamFileRequest.findUniqueOrThrow({
      where: { id: result.id },
      include: { recipients: true },
    });
    assert.equal(
      request.recipients.length,
      2,
      "ALL derives active recipients server-side",
    );
    assert.equal(deliveries, 1, "quiet member gets no request alert");
    const rows = await prisma.teamNotification.findMany({
      where: { teamId: team.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, recipient.id);
    assert.equal(rows[0].encryptedMetadata, envelope);
    assert.equal(rows[0].metadata, null);
    assert.ok(!JSON.stringify(rows).includes(dto.subject));
    assert.ok(!JSON.stringify(rows).includes(dto.note));
    const emails = await prisma.emailOutbox.findMany();
    const testEmails = emails
      .map((row) => ({
        row,
        message: decryptOutboxEmail(
          row.encryptedPayload,
          "isolated-test-secret",
          row.deduplicationKey,
        ),
      }))
      .filter(({ message }) =>
        [recipient.email, quiet.email].includes(message.recipient),
      );
    assert.equal(testEmails.length, 2);
    for (const { row, message } of testEmails) {
      assert.ok(!JSON.stringify(row).includes(message.recipient));
      assert.ok(
        !message.text.includes(dto.subject) && !message.text.includes(dto.note),
      );
      assert.ok(!message.text.includes("#key="));
      assert.ok(message.expiresAt);
    }
    const folderService = Object.assign(Object.create(TeamService.prototype), {
      prisma,
    }) as TeamService;
    for (const userId of [creator.id, recipient.id]) {
      const roots = await folderService.getFolders(team.id, userId);
      assert.ok(!roots.some((f) => f.id === folder.id));
      const allLevels = await folderService.getFolders(team.id, userId, "*");
      assert.ok(
        allLevels.some(
          (f) =>
            f.id === folder.id && ["WRITE", "ADMIN"].includes(f.myPermission),
        ),
      );
      assert.ok(!allLevels.some((f) => f.id === foreignFolder.id));
    }
    const options = await service.options(team.id, creator.id);
    assert.ok(
      options.some((f) => f.id === folder.id && f.parentId === parent.id),
    );
    const completedShare = await prisma.share.create({
      data: {
        creatorId: recipient.id,
        teamFolderId: folder.id,
        teamFileRequestId: result.id,
        expiration: new Date(Date.now() + 86400000),
        isE2EEncrypted: true,
        files: { create: { name: "fixture.pdf", size: "42" } },
      },
    });
    assert.equal(
      (await service.get(team.id, result.id, creator.id)).recipients.find(
        (r) => r.user.id === recipient.id,
      )!.fileCount,
      0,
    );
    const shareService = new ShareService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
      config as never,
      {} as never,
      {} as never,
      {} as never,
      { sendToUser: async () => {} } as never,
      notifications as never,
    );
    const completions = await Promise.allSettled([
      shareService.complete(completedShare.id),
      shareService.complete(completedShare.id),
    ]);
    assert.equal(
      completions.filter((r) => r.status === "fulfilled").length,
      1,
      "concurrent completion is idempotent",
    );
    assert.equal(
      await prisma.teamNotification.count({
        where: { teamId: team.id, type: "FILE_REQUEST_SUBMITTED" },
      }),
      1,
    );
    const inbox = await service.get(team.id, result.id, recipient.id);
    assert.equal(
      inbox.recipients.length,
      1,
      "recipient cannot see other recipients' progress",
    );
    assert.equal(inbox.recipients[0].fileCount, 1);
    assert.ok(!("submissionNotification" in inbox));
    await assert.rejects(
      service.close(team.id, result.id, recipient.id),
      NotFoundException,
    );
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: recipient.id, teamId: team.id } },
      data: { pushNotifMode: "SHARES_ONLY" },
    });
    const second = await service.create(team.id, creator.id, {
      ...dto,
      id: randomUUID(),
      sendEmail: false,
      notifications: [],
    });
    assert.equal(
      await prisma.teamNotification.count({
        where: { teamId: team.id, type: "FILE_REQUESTED" },
      }),
      1,
    );
    await assert.rejects(
      prisma.$transaction((tx) =>
        assertFileRequestUpload(tx, second.id, outsider.id, folder.id),
      ),
      NotFoundException,
    );
    const access = await prisma.teamFolderAccess.findFirstOrThrow({
      where: { folderId: folder.id, member: { userId: recipient.id } },
    });
    await prisma.teamFolderAccess.update({
      where: { id: access.id },
      data: { permission: "READ" },
    });
    await assert.rejects(
      prisma.$transaction((tx) =>
        assertFileRequestUpload(tx, second.id, recipient.id, folder.id),
      ),
      ForbiddenException,
    );
    await assert.rejects(
      service.create(team.id, creator.id, { ...dto, id: randomUUID() }),
      BadRequestException,
    );
    await prisma.teamFolderAccess.update({
      where: { id: access.id },
      data: { permission: "WRITE" },
    });

    // Close waits for a submission transaction holding the SQLite writer lock.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const upload = prisma.$transaction(async (tx) => {
      await assertFileRequestUpload(tx, second.id, recipient.id, folder.id);
      locked();
      await gate;
    });
    await ready;
    let closed = false;
    const close = service.close(team.id, second.id, creator.id).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(closed, false);
    release();
    await Promise.all([upload, close]);
    await assert.rejects(
      prisma.$transaction((tx) =>
        assertFileRequestUpload(tx, second.id, recipient.id, folder.id),
      ),
      ForbiddenException,
    );

    await prisma.teamFileRequest.update({
      where: { id: result.id },
      data: { expiresAt: new Date(Date.now() - 91 * 86400000) },
    });
    await service.cleanup();
    assert.equal(
      await prisma.teamFileRequest.findUnique({ where: { id: result.id } }),
      null,
    );
    assert.equal(
      (
        await prisma.share.findUniqueOrThrow({
          where: { id: completedShare.id },
        })
      ).teamFileRequestId,
      null,
    );
    assert.equal(
      await prisma.file.count({ where: { shareId: completedShare.id } }),
      1,
      "retention never deletes submitted files",
    );
    // Exercise encrypted request writes and metadata rotation through real Prisma transactions.
    const flag = process.env.FILE_META_V1_TEAM_WRITE;
    const masterFlag = process.env.FILE_META_V1_WRITE;
    process.env.FILE_META_V1_WRITE = "true";
    const rollout = process.env.FILE_META_V1_ROLLOUT_PERCENT;
    process.env.FILE_META_V1_ROLLOUT_PERCENT = "100";
    process.env.FILE_META_V1_TEAM_WRITE = "true";
    try {
      const rotationTeam = await prisma.team.create({
        data: {
          ownerId: creator.id,
          slug: randomUUID(),
          name: "Rotation fixture",
          members: {
            create: [
              {
                userId: creator.id,
                role: "OWNER",
                isActive: true,
                wrappedTeamKey: "old-owner-key",
                teamKeyVersion: 1,
              },
              {
                userId: recipient.id,
                isActive: true,
                wrappedTeamKey: "old-recipient-key",
                teamKeyVersion: 1,
              },
            ],
          },
        },
      });
      teamIds.push(rotationTeam.id);
      const rotationFolder = await prisma.teamFolder.create({
        data: {
          teamId: rotationTeam.id,
          name: "Rotation",
          storagePrefix: randomUUID(),
          accessRules: {
            create: [
              {
                memberId: (
                  await prisma.teamMember.findUniqueOrThrow({
                    where: {
                      userId_teamId: {
                        userId: recipient.id,
                        teamId: rotationTeam.id,
                      },
                    },
                  })
                ).id,
                permission: "WRITE",
              },
            ],
          },
        },
      });
      const oldInfo = Buffer.alloc(92, 7).toString("base64url");
      const newInfo = Buffer.alloc(92, 8).toString("base64url");
      const changedInfo = Buffer.alloc(92, 9).toString("base64url");
      const encryptedRequest = await service.create(
        rotationTeam.id,
        creator.id,
        {
          id: randomUUID(),
          folderId: rotationFolder.id,
          subject: "",
          encryptedInfo: oldInfo,
          recipientScope: "SELECTED",
          recipientIds: [recipient.id],
          sendEmail: false,
          notifications: [
            { userId: recipient.id, encryptedMetadata: envelope },
          ],
          submissionNotification: envelope,
        },
      );
      const encryptedRow = await prisma.teamFileRequest.findUniqueOrThrow({
        where: { id: encryptedRequest.id },
      });
      assert.equal(encryptedRow.subject, "");
      assert.equal(encryptedRow.note, null);
      const encryptedShare = await prisma.share.create({
        data: {
          creatorId: creator.id,
          teamFolderId: rotationFolder.id,
          isE2EEncrypted: true,
          uploadLocked: true,
          fileMetadataScheme: 1,
          encryptedInfo: oldInfo,
          expiration: new Date(Date.now() + 86400000),
        },
      });
      const teamService = new TeamService(
        prisma as never,
        {} as never,
        config as never,
        {} as never,
        notifications as never,
        outbox,
        {} as never,
      );
      teamService.logAccess = async () => {};
      const rotation = await teamService.startTeamKeyRotation(
        rotationTeam.id,
        creator.id,
        {
          newWrappedTeamKey: "new-owner-key",
        },
      );
      await assert.rejects(
        service.create(rotationTeam.id, creator.id, {
          id: randomUUID(),
          folderId: rotationFolder.id,
          subject: "",
          encryptedInfo: oldInfo,
          recipientScope: "SELECTED",
          recipientIds: [recipient.id],
          sendEmail: false,
          notifications: [
            { userId: recipient.id, encryptedMetadata: envelope },
          ],
          submissionNotification: envelope,
        }),
        BadRequestException,
      );
      await assert.rejects(
        teamService.completeTeamKeyRotation(
          rotationTeam.id,
          rotation.id,
          creator.id,
        ),
        ConflictException,
      );
      await teamService.stageTeamRotationMetadata(
        rotationTeam.id,
        rotation.id,
        creator.id,
        {
          kind: "SHARE",
          id: encryptedShare.id,
          expectedEncryptedInfo: oldInfo,
          encryptedInfo: newInfo,
        },
      );
      await assert.rejects(
        teamService.completeTeamKeyRotation(
          rotationTeam.id,
          rotation.id,
          creator.id,
        ),
        ConflictException,
      );
      await teamService.stageTeamRotationMetadata(
        rotationTeam.id,
        rotation.id,
        creator.id,
        {
          kind: "REQUEST",
          id: encryptedRequest.id,
          expectedEncryptedInfo: oldInfo,
          encryptedInfo: newInfo,
        },
      );
      await prisma.teamFileRequest.update({
        where: { id: encryptedRequest.id },
        data: { encryptedInfo: changedInfo },
      });
      await assert.rejects(
        teamService.completeTeamKeyRotation(
          rotationTeam.id,
          rotation.id,
          creator.id,
        ),
        ConflictException,
      );
      assert.equal(
        (
          await prisma.share.findUniqueOrThrow({
            where: { id: encryptedShare.id },
          })
        ).encryptedInfo,
        oldInfo,
      );
      assert.equal(
        (
          await prisma.team.findUniqueOrThrow({
            where: { id: rotationTeam.id },
          })
        ).keyVersion,
        1,
      );
      assert.equal(
        (
          await prisma.teamMember.findUniqueOrThrow({
            where: {
              userId_teamId: {
                userId: recipient.id,
                teamId: rotationTeam.id,
              },
            },
          })
        ).wrappedTeamKey,
        "old-recipient-key",
      );
      await teamService.stageTeamRotationMetadata(
        rotationTeam.id,
        rotation.id,
        creator.id,
        {
          kind: "REQUEST",
          id: encryptedRequest.id,
          expectedEncryptedInfo: changedInfo,
          encryptedInfo: newInfo,
        },
      );
      await teamService.completeTeamKeyRotation(
        rotationTeam.id,
        rotation.id,
        creator.id,
      );
      assert.equal(
        (
          await prisma.share.findUniqueOrThrow({
            where: { id: encryptedShare.id },
          })
        ).encryptedInfo,
        newInfo,
      );
      assert.equal(
        (
          await prisma.teamFileRequest.findUniqueOrThrow({
            where: { id: encryptedRequest.id },
          })
        ).encryptedInfo,
        newInfo,
      );
      assert.equal(
        (
          await prisma.team.findUniqueOrThrow({
            where: { id: rotationTeam.id },
          })
        ).keyVersion,
        2,
      );
      assert.equal(
        (
          await prisma.teamMember.findUniqueOrThrow({
            where: {
              userId_teamId: {
                userId: creator.id,
                teamId: rotationTeam.id,
              },
            },
          })
        ).wrappedTeamKey,
        "new-owner-key",
      );
    } finally {
      if (masterFlag === undefined) delete process.env.FILE_META_V1_WRITE;
      else process.env.FILE_META_V1_WRITE = masterFlag;
      if (rollout === undefined)
        delete process.env.FILE_META_V1_ROLLOUT_PERCENT;
      else process.env.FILE_META_V1_ROLLOUT_PERCENT = rollout;
      if (flag === undefined) delete process.env.FILE_META_V1_TEAM_WRITE;
      else process.env.FILE_META_V1_TEAM_WRITE = flag;
    }
    console.log(
      "SQLite integration passed: tenant isolation, all-member scope, preferences, encrypted notifications/outbox, nested destination, completion concurrency, revocation, closing, retention and encrypted metadata rotation",
    );
    await prisma.emailOutbox.deleteMany({
      where: { id: { in: testEmails.map((e) => e.row.id) } },
    });
  } finally {
    await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    rmSync(fixture, { recursive: true, force: true });
  }
}
void main();
