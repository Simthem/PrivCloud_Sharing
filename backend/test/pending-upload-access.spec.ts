import "reflect-metadata";
import assert from "node:assert/strict";
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
} from "@nestjs/common";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { ShareService } from "src/share/share.service";
import { ShareDTO } from "src/share/dto/share.dto";
import { ShareSecurityGuard } from "src/share/guard/shareSecurity.guard";
import { FileSecurityGuard } from "src/file/guard/fileSecurity.guard";
import { JobsService } from "src/jobs/jobs.service";
import { getAdminUploadStatus } from "src/share/admin-upload-status.util";
import { createUnitTestRunner } from "./unit-test";
const { testCase, run } = createUnitTestRunner("unfinished upload recovery");
const logger = { log() {}, warn() {}, debug() {}, error() {} };
type FixtureFile = {
  id?: string;
  size: string;
  name?: string;
  encryptedMetadata?: string;
};
type PendingShare = { uploadPending: boolean; teamId?: string };
type PendingUpload = {
  id: string;
  canResume: boolean;
  size: number;
  fileCount: number;
};
type PendingQuery = {
  where: {
    creatorId: string;
    uploadLocked: boolean;
    removedReason: null;
    OR: { expiration: { gt: Date } }[];
  };
  select: { files: { select: { name?: boolean } } };
};
type AccessCheck = (id: string, user: { id: string }) => Promise<void>;
type ShareServiceDouble = {
  prisma: {
    share: {
      findUnique: () => Promise<unknown>;
      findMany?: (input: PendingQuery) => Promise<unknown[]>;
    };
    user: { findUnique: () => Promise<unknown> };
  };
  teamShareAccessService?: {
    assertCanAccessShare: AccessCheck;
    assertCanManageShare: AccessCheck;
  };
  increaseViewCount?: () => Promise<void>;
  get(id: string, recoveringUserId?: string): Promise<unknown>;
  getPendingUploadsByUser(userId: string): Promise<PendingUpload[]>;
};
type JobsServiceDouble = {
  logger: typeof logger;
  runExclusive: (name: string, fn: () => Promise<void>) => Promise<void>;
  prisma: {
    share: {
      findMany: () => Promise<{ id: string }[]>;
      deleteMany: () => Promise<{ count: number }>;
    };
  };
  fileService: { deleteAllFiles: () => Promise<void> };
  deleteExpiredShares(): Promise<void>;
};
function serviceFixture(
  files: FixtureFile[] = [
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
  const service: ShareServiceDouble = Object.create(ShareService.prototype);
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
    const result = (await service.get("share-1", "owner")) as PendingShare;
    assert.equal(result.uploadPending, true);
    assert.equal(new ShareDTO().from(result).uploadPending, true);
    for (const userId of [undefined, "foreign", "platform-admin"])
      await assert.rejects(
        service.get("share-1", userId),
        (e: HttpException) => e.getStatus() === 404,
      );
    const empty = serviceFixture([]);
    assert.equal(
      ((await empty.service.get("share-1", "owner")) as PendingShare)
        .uploadPending,
      true,
    );
  },
);
testCase(
  "owner recovery returns wrapped Team context without plaintext keys",
  async () => {
    const { service, share } = serviceFixture();
    share.teamFolderId = "folder";
    share.teamFolder = { teamId: "team" };
    const result = (await service.get("share-1", "owner")) as PendingShare;
    assert.equal(result.teamId, "team");
    assert.equal(result.uploadPending, true);
    const dto = new ShareDTO().from({
      ...result,
      key: "forbidden",
      wrappedShareKey: "forbidden",
    } as Partial<ShareDTO>) as ShareDTO & {
      key?: string;
      wrappedShareKey?: string;
    };
    assert.equal(dto.key, undefined);
    assert.equal(dto.wrappedShareKey, undefined);
  },
);
testCase(
  "recovery discovery is scoped to owner, unexpired shares, including uploads without a committed file",
  async () => {
    const { service } = serviceFixture();
    let query: PendingQuery;
    service.prisma.share.findMany = async (input) => {
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
      assertCanAccessShare: async (id, user) => {
        assert.equal(user.id, "owner");
        if (id === "denied-team") throw new ForbiddenException();
      },
      assertCanManageShare: async (id, user) => {
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
      rows.map((row) => row.id),
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
        const guard = new guardClass(
          service as unknown as ShareService,
          service.prisma as unknown as PrismaService,
          { get: () => true } as unknown as ConfigService,
          {} as TeamShareAccessService,
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
        } as unknown as ExecutionContext;
        if (id === "owner")
          assert.equal(await guard.canActivate(context), true);
        else
          await assert.rejects(
            guard.canActivate(context),
            (e: HttpException) => e.getStatus() === 404,
          );
        if (id === "owner") {
          share.security = { password: "hash" };
          await assert.rejects(
            guard.canActivate(context),
            (e: HttpException) => e.getStatus() === 403,
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
      const service: JobsServiceDouble = Object.create(JobsService.prototype);
      service.logger = logger;
      service.runExclusive = async (_name, fn) => fn();
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
