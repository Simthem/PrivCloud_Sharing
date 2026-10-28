import "reflect-metadata";
import assert from "node:assert/strict";
import { S3FileService } from "src/file/s3.service";
import { LocalFileService } from "src/file/local.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("file deletion resilience");

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  log: () => undefined,
};

const fileRecord = { id: "file-1", name: "contract.pdf", size: "1024" };

type S3Command = {
  input: { UploadId?: string; KeyMarker?: string; UploadIdMarker?: string };
  constructor: { name: string };
};
// Storage services built from their prototype, with the collaborators a test
// replaces and the methods it calls.
type StorageDouble = {
  logger: typeof silentLogger;
  config: { get: () => string };
  prisma: {
    file: {
      findFirst: () => Promise<unknown>;
      delete: (query: { where: { id: string } }) => Promise<unknown>;
    };
  };
  getShareObjectKey: () => string;
  getSharePrefix: () => string;
  resolveSharePath: () => string;
  multipartUploads: Map<string, unknown>;
  abortShareMultipartUploads: (shareId: string) => Promise<void>;
  getS3Instance: () => { send: (command: S3Command) => Promise<unknown> };
  remove(shareId: string, fileId: string): Promise<unknown>;
  deleteAllFiles(shareId: string): Promise<unknown>;
};

// The constructor schedules an interval; the prototype is enough to exercise
// remove() without leaving a timer behind.
const buildS3Service = (send: () => Promise<unknown>) => {
  const deleted: string[] = [];
  const service: StorageDouble = Object.create(S3FileService.prototype);
  service.logger = silentLogger;
  service.config = { get: () => "bucket" };
  service.prisma = {
    file: {
      findFirst: async () => fileRecord,
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return fileRecord;
      },
    },
  };
  service.getShareObjectKey = () => "share-1/file-1";
  service.getS3Instance = () => ({ send });
  return { service, deleted };
};

testCase(
  "removes the database record when the S3 object is already gone",
  async () => {
    const missingKey = Object.assign(
      new Error("The specified key does not exist."),
      {
        name: "NoSuchKey",
        Code: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      },
    );

    const { service, deleted } = buildS3Service(async () => {
      throw missingKey;
    });
    await service.remove("share-1", "file-1");
    assert.deepEqual(deleted, ["file-1"]);
  },
);

testCase(
  "still refuses to delete the record on a real S3 failure",
  async () => {
    const denied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    const { service, deleted } = buildS3Service(async () => {
      throw denied;
    });
    await assert.rejects(
      () => service.remove("share-1", "file-1"),
      /Could not delete file from S3/,
    );
    assert.deepEqual(deleted, []);
  },
);

testCase(
  "removes the database record when the stored file is already gone",
  async () => {
    const deleted: string[] = [];
    const service: StorageDouble = Object.create(LocalFileService.prototype);
    service.logger = silentLogger;
    service.prisma = {
      file: {
        findFirst: async () => fileRecord,
        delete: async ({ where }: { where: { id: string } }) => {
          deleted.push(where.id);
          return fileRecord;
        },
      },
    };
    service.resolveSharePath = () =>
      "/nonexistent-share-directory/nonexistent-file";
    await service.remove("share-1", "file-1");
    assert.deepEqual(deleted, ["file-1"]);
  },
);


testCase("batch S3 errors inside HTTP 200 prevent successful share deletion", async () => {
  const service: StorageDouble = Object.create(S3FileService.prototype);
  service.logger = silentLogger; service.config = { get: () => "bucket" };
  service.getSharePrefix = () => "share-1/"; service.abortShareMultipartUploads = async () => {};
  let sends = 0;
  service.getS3Instance = () => ({ send: async () => ++sends === 1 ? { Contents: [{ Key: "share-1/file-1" }] } : { Errors: [{ Code: "AccessDenied", Key: "share-1/file-1" }] } });
  await assert.rejects(service.deleteAllFiles("share-1"), /Could not delete all files from S3/);
});
testCase("multipart abort errors propagate while already absent uploads remain idempotent", async () => {
  for (const code of ["AccessDenied", "NoSuchUpload"]) {
    const service: StorageDouble = Object.create(S3FileService.prototype);
    service.logger = silentLogger; service.config = { get: () => "bucket" };
    service.getSharePrefix = () => "share-1/"; service.multipartUploads = new Map();
    let sends = 0;
    service.getS3Instance = () => ({ send: async () => { if (++sends === 1) return { Uploads: [{ Key: "share-1/file-1", UploadId: "upload" }] }; throw Object.assign(new Error("fixture"), { name: code }); } });
    if (code === "AccessDenied") await assert.rejects(service.abortShareMultipartUploads("share-1"), /Could not abort all multipart/);
    else await service.abortShareMultipartUploads("share-1");
  }
});
testCase("multipart cancellation paginates before acknowledging deletion", async () => {
  const service: StorageDouble = Object.create(S3FileService.prototype);
  service.logger = silentLogger; service.config = { get: () => "bucket" };
  service.getSharePrefix = () => "share-1/"; service.multipartUploads = new Map();
  const queries: S3Command["input"][] = [];
  service.getS3Instance = () => ({ send: async (command: S3Command) => {
    queries.push(command.input);
    if (command.constructor.name === "AbortMultipartUploadCommand") return {};
    return command.input.KeyMarker ? { Uploads: [{ Key: "share-1/file-2", UploadId: "u2" }] } : { Uploads: [{ Key: "share-1/file-1", UploadId: "u1" }], IsTruncated: true, NextKeyMarker: "share-1/file-1", NextUploadIdMarker: "u1" };
  } });
  await service.abortShareMultipartUploads("share-1");
  assert.equal(queries.filter(query => query.UploadId).length, 2);
  assert.ok(queries.some(query => query.KeyMarker === "share-1/file-1" && query.UploadIdMarker === "u1"));
});

run();
