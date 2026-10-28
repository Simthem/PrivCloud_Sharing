import "reflect-metadata";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { ShareService } from "src/share/share.service";
import { JobsService } from "src/jobs/jobs.service";
import { S3FileService } from "src/file/s3.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("partial upload preservation");
const logger = { debug() {}, log() {}, warn() {}, error() {} };
type StoredShare = {
  creatorId: string | null;
  uploadLocked: boolean;
  hasBeenCompleted: boolean;
  _count: { files: number };
};
type RemovalOptions = {
  share?: Partial<StoredShare>;
  probeFails?: boolean;
  stored?: boolean;
};
type RemovalDouble = Pick<ShareService, "remove"> & {
  logger: typeof logger;
  prisma: {
    share: {
      findUnique: () => Promise<unknown>;
      delete: () => Promise<unknown>;
    };
    shareQuotaEvent: { deleteMany: () => Promise<{ count: number }> };
    $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
  };
  fileService: {
    hasCompletedUploadData: () => Promise<boolean>;
    deleteAllFiles: () => Promise<void>;
  };
};
type CleanupOptions = {
  creatorId?: string;
  files?: number;
  claimLost?: boolean;
  probeFails?: boolean;
  stored?: boolean;
  raced?: boolean;
  multipart?: boolean;
  active?: boolean;
};
type CleanupClaim = {
  where: { files?: unknown };
  data: { uploadCleanupStartedAt?: Date | null };
};
type CleanupDouble = Pick<JobsService, "deleteUnfinishedShares"> & {
  logger: typeof logger;
  config: { get: () => boolean };
  runExclusive: (name: string, job: () => Promise<void>) => Promise<void>;
  prisma: {
    share: {
      findMany: () => Promise<unknown[]>;
      updateMany: (query: CleanupClaim) => Promise<{ count: number }>;
      deleteMany: () => Promise<{ count: number }>;
    };
    shareQuotaEvent: { deleteMany: () => Promise<{ count: number }> };
    $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
  };
  fileService: {
    hasCompletedUploadData: () => Promise<boolean>;
    hasPendingMultipartUpload: () => Promise<boolean>;
    getRecentUploadActivity: () => Promise<Date | null>;
    deleteAllFiles: () => Promise<void>;
  };
};
type S3Command = { input?: unknown; constructor: { name: string } };
type S3Double = Pick<
  S3FileService,
  | "hasCompletedUploadData"
  | "hasPendingMultipartUpload"
  | "cleanupStaleS3Multiparts"
> & {
  logger: typeof logger;
  config: { get: () => string };
  getSharePrefix: () => string;
  getS3Path: () => string;
  prisma: {
    share: {
      findUnique: (query: { where: { id: string } }) => Promise<unknown>;
    };
  };
  getS3Instance: () => { send: (command: S3Command) => Promise<unknown> };
};
const discard = (service: RemovalDouble, confirmed = false, admin = false) =>
  service.remove("share-1", admin, undefined, undefined, confirmed);

function removalFixture(options: RemovalOptions = {}) {
  const share = {
    id: "share-1", creatorId: "owner", uploadLocked: false,
    hasBeenCompleted: false, storageProvider: "S3", _count: { files: 8 },
    ...options.share,
  };
  let storageDeletes = 0;
  let recordDeletes = 0;
  const service: RemovalDouble = Object.create(ShareService.prototype);
  service.logger = logger;
  service.prisma = {
    share: {
      findUnique: async () => share,
      delete: async () => { recordDeletes++; return share; },
    },
    shareQuotaEvent: { deleteMany: async () => ({ count: 1 }) },
    $transaction: async (ops) => Promise.all(ops),
  };
  service.fileService = {
    hasCompletedUploadData: async () => {
      if (options.probeFails) throw new Error("storage unavailable");
      return options.stored || false;
    },
    deleteAllFiles: async () => { storageDeletes++; },
  };
  return { service, counts: () => ({ storageDeletes, recordDeletes }) };
}

testCase("an ordinary DELETE cannot discard eight committed files", async () => {
  const f = removalFixture();
  await assert.rejects(() => discard(f.service), (e: HttpException) => e.getStatus() === 409);
  assert.deepEqual(f.counts(), { storageDeletes: 0, recordDeletes: 0 });
});
testCase("a premature completion by an older client does not authorize deletion", async () => {
  const f = removalFixture({ share: { hasBeenCompleted: true, uploadLocked: true } });
  await assert.rejects(() => discard(f.service), (e: HttpException) => e.getStatus() === 409);
  assert.deepEqual(f.counts(), { storageDeletes: 0, recordDeletes: 0 });
});
testCase("an S3 object without its database acknowledgement is preserved", async () => {
  const f = removalFixture({ share: { _count: { files: 0 } }, stored: true });
  await assert.rejects(() => discard(f.service), (e: HttpException) => e.getStatus() === 409);
  assert.deepEqual(f.counts(), { storageDeletes: 0, recordDeletes: 0 });
});
testCase("an unavailable S3 probe never grants permission to delete", async () => {
  const f = removalFixture({ share: { _count: { files: 0 } }, probeFails: true });
  await assert.rejects(() => discard(f.service), /storage unavailable/);
  assert.deepEqual(f.counts(), { storageDeletes: 0, recordDeletes: 0 });
});
testCase("confirmed cancellation, confirmed published deletion and admin deletion still work", async () => {
  for (const [confirmed, admin, completed] of [[true, false, false], [false, true, false], [true, false, true]]) {
    const f = removalFixture({ share: { hasBeenCompleted: completed, uploadLocked: completed } });
    await discard(f.service, confirmed, admin);
    assert.deepEqual(f.counts(), { storageDeletes: 1, recordDeletes: 1 });
  }
});
testCase("explicit discard never bypasses anonymous ownership proof", async () => {
  const f = removalFixture({ share: { creatorId: null } });
  await assert.rejects(() => discard(f.service, true), (e: HttpException) => e.getStatus() === 403);
  assert.deepEqual(f.counts(), { storageDeletes: 0, recordDeletes: 0 });
});
testCase("an empty unfinished share remains cancellable", async () => {
  const f = removalFixture({ share: { _count: { files: 0 } } });
  await discard(f.service);
  assert.deepEqual(f.counts(), { storageDeletes: 1, recordDeletes: 1 });
});

async function cleanupFixture(options: CleanupOptions = {}) {
  let storageDeletes = 0;
  let recordDeletes = 0;
  let probes = 0;
  const updates: CleanupClaim[] = [];
  const service: CleanupDouble = Object.create(JobsService.prototype);
  service.logger = logger;
  service.config = { get: () => false };
  service.runExclusive = async (_name, job) => job();
  service.prisma = {
    share: {
      findMany: async () => [{ id: "share-1", creatorId: options.creatorId ?? null, storageProvider: "S3", hasBeenCompleted: false, _count: { files: options.files || 0 } }],
      updateMany: async (query) => { updates.push(query); return { count: options.claimLost ? 0 : 1 }; },
      deleteMany: async () => { recordDeletes++; return { count: 1 }; },
    },
    shareQuotaEvent: { deleteMany: async () => ({ count: 1 }) },
    $transaction: async (ops) => Promise.all(ops),
  };
  service.fileService = {
    hasCompletedUploadData: async () => {
      probes++;
      if (options.probeFails) throw new Error("storage unavailable");
      return !!options.stored || (!!options.raced && probes > 1);
    },
    hasPendingMultipartUpload: async () => !!options.multipart,
    getRecentUploadActivity: async () => options.active ? new Date() : null,
    deleteAllFiles: async () => { storageDeletes++; },
  };
  await service.deleteUnfinishedShares();
  return { storageDeletes, recordDeletes, updates };
}

testCase("cleanup preserves partial files, orphan objects and active multipart transfers", async () => {
  for (const options of [{ files: 8 }, { stored: true }, { active: true }, { multipart: true }, { probeFails: true }]) {
    const result = await cleanupFixture(options);
    assert.equal(result.storageDeletes, 0);
    assert.equal(result.recordDeletes, 0);
  }
});
testCase("an owner's S3 upload survives inactivity even when the WAF blocked its first multipart init", async () => {
  const result = await cleanupFixture({ creatorId: "owner" });
  assert.equal(result.storageDeletes, 0);
  assert.equal(result.recordDeletes, 0);
  assert.deepEqual(result.updates, []);
});
testCase("completion between the storage probe and cleanup claim is preserved", async () => {
  const result = await cleanupFixture({ raced: true });
  assert.equal(result.storageDeletes, 0);
  assert.equal(result.recordDeletes, 0);
  assert.ok(result.updates.some(q => q.data.uploadCleanupStartedAt === null));
});
testCase("a concurrent heartbeat or committed file prevents the cleanup claim", async () => {
  const result = await cleanupFixture({ claimLost: true });
  assert.equal(result.storageDeletes, 0);
  assert.equal(result.recordDeletes, 0);
  assert.deepEqual(result.updates[0].where.files, { none: {} });
});
testCase("cleanup still releases an abandoned empty share reservation", async () => {
  const result = await cleanupFixture();
  assert.equal(result.storageDeletes, 1);
  assert.equal(result.recordDeletes, 1);
});
testCase("S3 completed-data probes are bounded to one object in the share prefix", async () => {
  const service: S3Double = Object.create(S3FileService.prototype);
  service.config = { get: () => "bucket" };
  service.getSharePrefix = () => "shares/share-1/";
  let query: unknown;
  service.getS3Instance = () => ({ send: async (command: S3Command) => { query = command.input; return { Contents: [{ Key: "shares/share-1/file-1" }] }; } });
  assert.equal(await service.hasCompletedUploadData("share-1"), true);
  assert.deepEqual(query, { Bucket: "bucket", Prefix: "shares/share-1/", MaxKeys: 1 });
  service.getS3Instance = () => ({ send: async () => ({ Contents: [] }) });
  assert.equal(await service.hasCompletedUploadData("share-1"), false);
});

testCase("pending multipart probes are bounded and preserve an inactive partial session", async () => {
  const service: S3Double = Object.create(S3FileService.prototype);
  service.config = { get: () => "bucket" }; service.getSharePrefix = () => "share-1/";
  let query: unknown;
  service.getS3Instance = () => ({ send: async (command: S3Command) => { query = command.input; return { Uploads: [{ Key: "share-1/file-1", UploadId: "upload" }] }; } });
  assert.equal(await service.hasPendingMultipartUpload("share-1"), true);
  assert.deepEqual(query, { Bucket: "bucket", Prefix: "share-1/", MaxUploads: 1 });
});
testCase("stale S3 cleanup preserves every multipart backed by a share and fails closed on database outages", async () => {
  for (const state of ["present", "missing", "unavailable"]) {
    const service: S3Double = Object.create(S3FileService.prototype);
    service.logger = logger; service.config = { get: () => "bucket" };
    service.getS3Path = () => "prefix/";
    service.prisma = { share: { findUnique: async ({ where }) => { assert.equal(where.id, "share-1"); if (state === "unavailable") throw new Error("database unavailable"); return state === "present" ? { id: where.id } : null; } } };
    let aborted = 0;
    service.getS3Instance = () => ({ send: async (command: S3Command) => {
      if (command.constructor.name === "ListMultipartUploadsCommand") return { Uploads: [{ Key: "prefix/share-1/file-1", UploadId: "upload", Initiated: new Date(Date.now() - 5 * 86400000) }] };
      if (command.constructor.name === "AbortMultipartUploadCommand") aborted++;
      return {};
    } });
    await service.cleanupStaleS3Multiparts(); assert.equal(aborted, state === "missing" ? 1 : 0);
  }
});

void run();
