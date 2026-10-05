import "reflect-metadata";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import { ShareService } from "src/share/share.service";
import { ShareDTO } from "src/share/dto/share.dto";
import { ShareSecurityGuard } from "src/share/guard/shareSecurity.guard";
import { FileSecurityGuard } from "src/file/guard/fileSecurity.guard";
import { JobsService } from "src/jobs/jobs.service";
import { getAdminUploadStatus } from "src/share/admin-upload-status.util";
import { createUnitTestRunner } from "./unit-test";
const { testCase, run } = createUnitTestRunner("unfinished upload recovery");
const logger = { log() {}, warn() {}, debug() {}, error() {} };
function serviceFixture(
  files: any[] = [
    { id: "file-1", size: "100", name: "opaque", encryptedMetadata: "opaque" },
  ],
) {
  const share = {
    id: "share-1",
    creatorId: "owner",
    uploadLocked: false,
    files,
    security: null,
    reverseShare: null,
    teamFolder: null,
    teamFolderId: null,
    expiration: new Date(Date.now() + 86400000),
  };
  const service: any = Object.create(ShareService.prototype);
  service.prisma = {
    share: { findUnique: async () => share },
    user: { findUnique: async () => ({ isAdmin: true }) },
  };
  return { service, share };
}
testCase(
  "only the authenticated uploader can inspect saved files before finalization",
  async () => {
    const { service } = serviceFixture();
    const result: any = await service.get("share-1", "owner");
    assert.equal(result.uploadPending, true);
    assert.equal(new ShareDTO().from(result).uploadPending, true);
    for (const userId of [undefined, "foreign", "platform-admin"])
      await assert.rejects(
        service.get("share-1", userId),
        (e: any) => e.getStatus() === 404,
      );
    const empty = serviceFixture([]);
    assert.equal(
      (await empty.service.get("share-1", "owner")).uploadPending,
      true,
    );
  },
);
testCase(
  "owner recovery returns wrapped Team context without plaintext keys",
  async () => {
    const { service, share } = serviceFixture();
    share.teamFolderId = "folder" as any;
    share.teamFolder = { teamId: "team" } as any;
    const result: any = await service.get("share-1", "owner");
    assert.equal(result.teamId, "team");
    assert.equal(result.uploadPending, true);
    const dto: any = new ShareDTO().from({
      ...result,
      key: "forbidden",
      wrappedShareKey: "forbidden",
    });
    assert.equal(dto.key, undefined);
    assert.equal(dto.wrappedShareKey, undefined);
  },
);
testCase(
  "recovery discovery is scoped to owner, unexpired shares, including uploads without a committed file",
  async () => {
    const { service } = serviceFixture();
    let query: any;
    service.prisma.share.findMany = async (input: any) => {
      query = input;
      return [
        {
          id: "personal",
          createdAt: new Date(),
          expiration: new Date(),
          teamFolderId: null,
          files: [{ size: "100" }],
        },
        {
          id: "allowed-team",
          createdAt: new Date(),
          expiration: new Date(),
          teamFolderId: "team",
          files: [{ size: "42" }],
        },
        {
          id: "readonly-team",
          createdAt: new Date(),
          expiration: new Date(),
          teamFolderId: "team",
          files: [{ size: "23" }],
        },
        {
          id: "denied-team",
          createdAt: new Date(),
          expiration: new Date(),
          teamFolderId: "team",
          files: [{ size: "77" }],
        },
      ];
    };
    service.teamShareAccessService = {
      assertCanAccessShare: async (id: string, user: any) => {
        assert.equal(user.id, "owner");
        if (id === "denied-team") throw new ForbiddenException();
      },
      assertCanManageShare: async (id: string, user: any) => {
        assert.equal(user.id, "owner");
        if (id === "readonly-team") throw new ForbiddenException();
      },
    };
    const rows = await service.getPendingUploadsByUser("owner");
    assert.equal(query.where.creatorId, "owner");
    assert.equal(query.where.uploadLocked, false);
    assert.equal(query.where.removedReason, null);
    assert.ok(query.where.OR[0].expiration.gt instanceof Date);
    assert.deepEqual(
      rows.map((row: any) => row.id),
      ["personal", "allowed-team", "readonly-team"],
    );
    assert.equal(rows[2].canResume, false);
    assert.equal(rows[0].canResume, true);
    assert.equal(rows[0].size, 100);
    assert.equal(rows[0].fileCount, 1);
    assert.equal(query.select.files.select.name, undefined);
    service.teamShareAccessService.assertCanManageShare = async () => {
      throw new Error("database unavailable");
    };
    await assert.rejects(
      service.getPendingUploadsByUser("owner"),
      /database unavailable/,
    );
  },
);
testCase(
  "unfinished metadata and download guards reject foreign and anonymous visitors",
  async () => {
    for (const guardClass of [ShareSecurityGuard, FileSecurityGuard]) {
      for (const id of [undefined, "foreign", "owner"]) {
        const { service, share } = serviceFixture();
        const guard: any = new guardClass(
          service,
          service.prisma,
          { get: () => true } as any,
          {} as any,
        );
        service.increaseViewCount = async () => {};
        const request = {
          params: { shareId: "share-1", fileId: "file-1" },
          cookies: {},
          user: id ? { id } : undefined,
        };
        const context = {
          switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({}),
          }),
        };
        if (id === "owner")
          assert.equal(await guard.canActivate(context as any), true);
        else
          await assert.rejects(
            guard.canActivate(context as any),
            (e: any) => e.getStatus() === 404,
          );
        if (id === "owner") {
          share.security = { password: "hash" } as any;
          await assert.rejects(
            guard.canActivate(context as any),
            (e: any) => e.getStatus() === 403,
          );
        }
      }
    }
  },
);
testCase(
  "failed S3 expiry deletion retains the database row for retry",
  async () => {
    for (const storageFails of [true, false]) {
      let deleted = 0;
      const service: any = Object.create(JobsService.prototype);
      service.logger = logger;
      service.runExclusive = async (_name: string, fn: () => Promise<void>) =>
        fn();
      service.prisma = {
        share: {
          findMany: async () => [{ id: "expired" }],
          deleteMany: async () => {
            deleted++;
            return { count: 1 };
          },
        },
      };
      service.fileService = {
        deleteAllFiles: async () => {
          if (storageFails) throw new Error("S3 unavailable");
        },
      };
      await service.deleteExpiredShares();
      assert.equal(deleted, storageFails ? 0 : 1);
    }
  },
);
testCase(
  "admin distinguishes finalization from recent activity without assuming bytes are moving",
  () => {
    const now = new Date();
    assert.equal(getAdminUploadStatus({ uploadLocked: true }, now), "READY");
    assert.equal(
      getAdminUploadStatus({ uploadLocked: false }, now),
      "UNFINISHED",
    );
    assert.equal(
      getAdminUploadStatus(
        { uploadLocked: false, uploadLastActivityAt: now },
        now,
      ),
      "UNFINISHED",
    );
    assert.equal(
      getAdminUploadStatus(
        {
          uploadLocked: false,
          uploadLastActivityAt: new Date(now.getTime() - 46 * 60000),
        },
        now,
      ),
      "INACTIVE",
    );
  },
);
void run();
